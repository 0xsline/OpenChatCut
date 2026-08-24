import {
  jsonSchema,
  streamText,
  tool,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import {
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  type LlmProvider,
  type OpenAiApiMode,
} from '../../shared/llm-providers';
import {
  MODEL_CAPABILITY_OVERRIDES_KEY,
  parseModelCapabilityOverrides,
  resolveModelCapabilities,
  type ModelCapabilities,
} from '../../shared/model-capabilities';
import { getKey } from '../keystore';
import {
  assertCanonicalToolInvocation,
  canonicalServerRunToolCatalog,
  resolveServerRunToolCatalog,
} from './tool-policy';
import { createServerLanguageModel, serverProviderOptions } from './model';
import {
  estimateTextTokens,
  type AgentContextUsage,
  type ContextPreparation,
} from '../../src/agent/context-compaction';
import { toolResultModelOutput } from '../../src/agent/tool-result-output';
import { redactTextForAgentRuntime } from '../../src/agent/runtime-artifact';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { ToolActivation } from '../../src/agent/tool-activation';
import {
  buildServerRunPrompt,
  SERVER_RUN_AI_TIMEOUT,
  prepareServerContext,
  type ServerContextInput,
} from './context';
import {
  digestToolArgs,
  pushRunEvent,
  recordServerContextUsage,
  setRunStatus,
  waitForToolResult,
  type ServerRun,
} from './store';
import { classifyLlmFailure, runServerTurnWithRetry } from './llm-retry';
import { toolExecutionMode } from '../../src/agent/tools/execution-modes';
import {
  isFailedToolResult,
  toolFailureReason,
  ToolFailureTracker,
} from '../../src/agent/toolFailure';
import {
  collectServerText,
  resolveServerRunMaxOutputTokens,
  serverRunTextMetadata,
} from './executor-events';
export {
  flushTextEvents,
  collectServerText,
  flushThinkingEvents,
  resolveServerRunMaxOutputTokens,
  serverRunTextMetadata,
} from './executor-events';
function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactTextForAgentRuntime(raw).trim().slice(0, 1_200)
    || 'Agent provider request failed.';
}
export interface ActivationState {
  current: ToolActivation;
  tail: Promise<void>;
  followupText: string | null;
  toolFailures: ToolFailureTracker;
  repeatGuardNote?: string;
  lastSuccessfulPureTool?: {
    name: string;
    argsDigest: string;
    result: unknown;
  };
}

function cacheablePureTool(name: string): boolean {
  return name === 'analyze_music';
}

export interface ServerRunInput {
  readonly messages: ModelMessage[];
  readonly backend?: string;
  readonly provider: string;
  readonly model: string;
  readonly openAiApiMode: OpenAiApiMode;
  readonly cacheMode: 'short' | 'long';
  readonly maxOutputTokens: number;
  readonly origin: string;
  readonly tools: readonly AgentToolSchema[];
  readonly instructions?: string;
}

type ServerTurnInput = Omit<ServerContextInput, 'schemas'> & {
  readonly activation: ActivationState;
  readonly requestIndex: number;
};

export async function executeBrowserTool(
  run: ServerRun,
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  toolCallId: string,
  activation: ActivationState,
): Promise<unknown> {
  const parallel = toolExecutionMode(schema.name) === 'parallel';
  let release: (() => void) | undefined;
  if (!parallel) {
    const previous = activation.tail;
    const { promise: next, resolve } = Promise.withResolvers<void>();
    activation.tail = next;
    release = resolve;
    await previous;
  }
  try {
    // A model may remember a tool from earlier in the conversation even when
    // the current request did not activate it. Activation is a token
    // optimization, not a security boundary: canonical membership (checked by
    // assertCanonicalToolInvocation below) is what actually gates the call.
    activation.current = activation.current.admit(schema.name);
    assertCanonicalToolInvocation(schema, args, activation.current.schemas());
    const argsDigest = digestToolArgs(args);
    const cached = activation.lastSuccessfulPureTool;
    if (cacheablePureTool(schema.name)
      && cached?.name === schema.name
      && cached.argsDigest === argsDigest) {
      activation.repeatGuardNote = `Reused the adjacent successful ${schema.name} result; skipped duplicate browser execution.`;
      const shaped = activation.current.withToolResult(schema.name, cached.result);
      activation.current = shaped.activation;
      return shaped.result;
    }
    activation.repeatGuardNote = undefined;
    activation.lastSuccessfulPureTool = undefined;
    pushRunEvent(run, 'tool-request', {
      toolCallId,
      name: schema.name,
      args,
      argsDigest,
    });
    const delivered = await waitForToolResult(
      run,
      toolCallId,
      schema.name,
      argsDigest,
    );
    const followup = delivered && typeof delivered === 'object'
      && '__followup' in delivered
      && typeof delivered.__followup === 'string'
      ? delivered.__followup
      : null;
    if (followup) activation.followupText = followup;
    const shaped = activation.current.withToolResult(schema.name, delivered);
    activation.current = shaped.activation;
    if (isFailedToolResult(shaped.result)) {
      throw new Error(toolFailureReason(shaped.result));
    }
    activation.toolFailures.record(schema.name, { success: true, result: shaped.result });
    if (cacheablePureTool(schema.name)) {
      activation.lastSuccessfulPureTool = { name: schema.name, argsDigest, result: shaped.result };
    }
    return shaped.result;
  } catch (error) {
    activation.toolFailures.record(schema.name, { success: false, result: error });
    throw error;
  } finally {
    release?.();
  }
}

function createServerTools(
  run: ServerRun,
  schemas: readonly AgentToolSchema[],
  activation: ActivationState,
) {
  return Object.fromEntries(schemas.map((schema) => [schema.name, tool({
    description: schema.description,
    inputSchema: jsonSchema<Record<string, unknown>>(
      schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
    ),
    execute: (args: Record<string, unknown>, options: { toolCallId: string }) => (
      executeBrowserTool(
        run,
        schema,
        args,
        options.toolCallId,
        activation,
      )
    ),
    toModelOutput: ({ output }) => toolResultModelOutput(
      output,
      schema.name === 'load_skill',
    ),
  })]));
}

function measuredContextUsage(
  prepared: ContextPreparation,
  total: LanguageModelUsage,
  text: string,
  requestIndex: number,
): AgentContextUsage {
  return {
    ...prepared.usage,
    inputTokens: total.inputTokens ?? prepared.usage.inputTokens,
    outputTokens: total.outputTokens ?? estimateTextTokens(text),
    reasoningTokens: total.outputTokenDetails.reasoningTokens,
    noCacheInputTokens: total.inputTokenDetails.noCacheTokens,
    cacheReadTokens: total.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: total.inputTokenDetails.cacheWriteTokens,
    requestIndex,
    attemptIndex: 0,
  };
}

async function executeServerTurn(
  input: ServerTurnInput,
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
  hitMaxTokens: boolean;
}> {
  try {
    return await runServerTurnOnce(input);
  } catch (error) {
    // A context overflow means the estimate undershot the real tokenizer.
    // Compress once, regardless of the estimated pressure, then retry the
    // exact same turn. Deterministic retries for other failures live in
    // llm-retry.ts; this one must change the request before it can succeed.
    if (input.signal.aborted
      || input.forceCompact
      || classifyLlmFailure(error).code !== 'CONTEXT_WINDOW_EXCEEDED') {
      throw error;
    }
    pushRunEvent(input.run, 'context-overflow-retry', { requestIndex: input.requestIndex });
    return runServerTurnOnce({ ...input, forceCompact: true });
  }
}

async function runServerTurnOnce(
  input: ServerTurnInput,
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
  hitMaxTokens: boolean;
}> {
  const schemas = input.activation.current.schemas();
  const prepared = await prepareServerContext({ ...input, schemas });
  const tools = createServerTools(
    input.run,
    schemas,
    input.activation,
  );
  pushRunEvent(input.run, 'text-start', {});
  const options = serverProviderOptions(input.provider, input.apiMode, input.cacheMode);
  const result = streamText({
    model: input.model,
    instructions: input.instructions,
    messages: prepared.messages,
    tools,
    ...(options ? { providerOptions: options } : {}),
    maxOutputTokens: input.maxOutputTokens,
    maxRetries: 0,
    abortSignal: input.signal,
    timeout: SERVER_RUN_AI_TIMEOUT,
  });
  const text = await collectServerText(input.run, result.fullStream);
  const [toolCalls, responseMessages, totalUsage] = await Promise.all([
    result.toolCalls,
    result.responseMessages,
    result.usage,
  ]);
  recordServerContextUsage(
    input.run,
    measuredContextUsage(prepared, totalUsage, text, input.requestIndex),
    schemas.length,
    JSON.stringify(schemas).length,
  );
  const continued = !input.activation.repeatGuardNote && (
    toolCalls.length > 0 || responseMessages.some((message) => message.role === 'tool')
  );
  return {
    messages: continued
      ? [...prepared.messages, ...responseMessages]
      : prepared.messages,
    text,
    followupText: input.activation.followupText,
    continued,
    hitMaxTokens: (await result.finishReason) === 'length',
  };
}

/**
 * Capability resolution for server-side runs. The keystore-backed
 * AGENT_MODEL_CAPABILITY_OVERRIDES must apply here exactly like the browser
 * model-selection path: models absent from the bundled catalog otherwise fall
 * back to 8K, which the system prompt plus tool schemas exceed on the very
 * first message (issue #81).
 */
export function resolveServerRunCapabilities(
  provider: LlmProvider,
  backend: 'codex' | 'api',
  modelId: string,
): ModelCapabilities {
  return resolveModelCapabilities(
    { backend, provider, modelId },
    parseModelCapabilityOverrides(getKey(MODEL_CAPABILITY_OVERRIDES_KEY)),
  );
}

function createExecutionPlan(run: ServerRun, input: ServerRunInput) {
  const provider = normalizeLlmProvider(input.provider);
  const apiMode = normalizeOpenAiApiMode(input.openAiApiMode);
  const backend = input.backend === 'codex' ? 'codex' : 'api';
  const requested = resolveServerRunToolCatalog(input.tools, run.askOnly);
  const capabilities = resolveServerRunCapabilities(provider, backend, input.model);
  const maxOutputTokens = resolveServerRunMaxOutputTokens(
    input.maxOutputTokens,
    capabilities.maxOutputTokens.value,
    capabilities.contextWindowTokens.value,
  );
  const maxInputTokens = capabilities.maxInputTokens.estimated
    ? Math.max(1, capabilities.contextWindowTokens.value - maxOutputTokens)
    : capabilities.maxInputTokens.value;
  const activation: ActivationState = {
    current: new ToolActivation(
      canonicalServerRunToolCatalog(run.askOnly),
      input.messages,
      requested.map((schema) => schema.name),
    ),
    tail: Promise.resolve(),
    followupText: null,
    toolFailures: new ToolFailureTracker(),
  };
  const prompt = buildServerRunPrompt({
    ...input,
    projectId: run.projectId,
    askOnly: run.askOnly,
    references: run.references,
  });
  return {
    backend,
    provider,
    apiMode,
    capabilities,
    maxOutputTokens,
    maxInputTokens,
    activation,
    prompt,
    model: backend === 'codex'
      ? undefined
      : createServerLanguageModel(
          provider,
          input.model,
          apiMode,
          input.origin,
        ),
  };
}

/** What the loop does after one turn, extracted for deterministic checks. */
export type TurnDisposition = 'continue' | 'completed' | 'failed' | 'max-tokens';
export function turnDisposition(
  hitMaxTokens: boolean,
  continued: boolean,
  hasUnresolvedFailure = false,
): TurnDisposition {
  if (hitMaxTokens) return hasUnresolvedFailure ? 'failed' : 'max-tokens';
  if (continued) return 'continue';
  return hasUnresolvedFailure ? 'failed' : 'completed';
}

async function executeRunTurns(
  run: ServerRun,
  input: ServerRunInput,
  signal: AbortSignal,
): Promise<void> {
  const plan = createExecutionPlan(run, input);
  let messages = plan.prompt.messages;
  // No turn cap: the model decides when the task is done. The only automatic
  // stop beside "no more tool calls" is an output-token cutoff, which would
  // otherwise feed truncated text back into the loop.
  for (let turn = 0; ; turn += 1) {
    const outcome = await runServerTurnWithRetry(run, turn + 1, signal, () =>
      plan.backend === 'codex'
        ? (async () => (await import('./codex-turn')).executeServerCodexTurn({
          run,
          messages,
          instructions: plan.prompt.instructions,
          schemas: plan.activation.current.schemas(),
          model: input.model,
          askOnly: run.askOnly,
          projectId: run.projectId,
          maxInputTokens: plan.maxInputTokens,
          maxOutputTokens: plan.maxOutputTokens,
          contextWindowTokens: plan.capabilities.contextWindowTokens.value,
          contextWindowEstimated: plan.capabilities.contextWindowTokens.estimated,
          signal,
          activation: plan.activation,
          requestIndex: turn + 1,
        }))()
        : executeServerTurn({
          run,
          messages,
          instructions: plan.prompt.instructions,
          model: plan.model!,
          provider: plan.provider,
          apiMode: plan.apiMode,
          cacheMode: input.cacheMode,
          contextWindowTokens: plan.capabilities.contextWindowTokens.value,
          contextWindowEstimated: plan.capabilities.contextWindowTokens.estimated,
          maxInputTokens: plan.maxInputTokens,
          maxOutputTokens: plan.maxOutputTokens,
          signal,
          activation: plan.activation,
          requestIndex: turn + 1,
        }),
    );
    if (outcome.followupText) {
      pushRunEvent(run, 'text-delta', { text: outcome.followupText });
      pushRunEvent(run, 'text-end', serverRunTextMetadata(outcome.followupText));
      pushRunEvent(run, 'finish', serverRunTextMetadata(outcome.followupText));
      await setRunStatus(run, 'awaiting-user');
      return;
    }
    messages = outcome.messages;
    const disposition = turnDisposition(
      outcome.hitMaxTokens,
      outcome.continued,
      plan.activation.toolFailures.hasUnresolved,
    );
    if (disposition === 'continue') continue;
    if (disposition === 'max-tokens') {
      pushRunEvent(run, 'max-tokens', { turn: turn + 1 });
    }
    if (disposition === 'failed') {
      throw new Error(plan.activation.toolFailures.report());
    }
    pushRunEvent(run, 'finish', {
      ...serverRunTextMetadata(outcome.text),
      ...(plan.activation.repeatGuardNote
        ? { guard: plan.activation.repeatGuardNote }
        : {}),
    });
    await setRunStatus(run, 'completed');
    return;
  }
}

async function settleRunFailure(
  run: ServerRun,
  abort: AbortController,
  error: unknown,
): Promise<void> {
  const cancelled = run.status === 'cancelled'
    || (abort.signal.aborted
      && run.status !== 'failed'
      && run.error === 'Agent run cancelled.');
  const message = cancelled ? 'Agent run cancelled.' : safeError(error);
  run.error = message;
  if (!run.persistenceError) {
    try {
      pushRunEvent(run, 'error', { message });
    } catch {
      // The event-cap path already scheduled a failed transport settlement.
    }
  }
  await setRunStatus(run, cancelled ? 'cancelled' : 'failed').catch(() => undefined);
}

export async function executeRun(
  run: ServerRun,
  input: ServerRunInput,
): Promise<void> {
  const abort = new AbortController();
  run.abort = abort;
  try {
    await setRunStatus(run, 'running');
    await executeRunTurns(run, input, abort.signal);
  } catch (error) {
    await settleRunFailure(run, abort, error);
  } finally {
    if (run.abort === abort) run.abort = undefined;
  }
}
