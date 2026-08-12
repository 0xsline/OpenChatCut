import { jsonSchema, streamText, tool, type LanguageModelUsage, type ModelMessage } from 'ai';
import {
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  type OpenAiApiMode,
} from '../../shared/llm-providers';
import { resolveModelCapabilities } from '../../shared/model-capabilities';
import {
  assertCanonicalToolInvocation,
  canonicalServerRunToolCatalog,
  resolveServerRunToolCatalog,
} from './tool-policy';
import { createServerLanguageModel, serverProviderOptions } from './model';
import {
  effectiveOutputTokenBudget,
  estimateTextTokens,
  type AgentContextUsage,
  type ContextPreparation,
} from '../../src/agent/context-compaction';
import { toolResultModelOutput } from '../../src/agent/tool-result-output';
import { redactTextForAgentRuntime } from '../../src/agent/runtime-artifact';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { ToolActivation } from '../../src/agent/tool-activation';
import { createInlineThinkingExtractor } from '../../src/agent/settings/agentSettings';
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
const MAX_TOOL_TURNS = 30;

const TEXT_EVENT_CHARS = 8_192;
export function resolveServerRunMaxOutputTokens(
  requested: number,
  capabilityLimit: number,
  contextWindow: number,
): number {
  return Math.min(
    requested,
    effectiveOutputTokenBudget(capabilityLimit, contextWindow),
  );
}

function flushTextEvents(run: ServerRun, pending: string, force: boolean): string {
  let remainder = pending;
  while (remainder.length >= TEXT_EVENT_CHARS) {
    pushRunEvent(run, 'text-delta', { text: remainder.slice(0, TEXT_EVENT_CHARS) });
    remainder = remainder.slice(TEXT_EVENT_CHARS);
  }
  if (force && remainder) {
    pushRunEvent(run, 'text-delta', { text: remainder });
    return '';
  }
  return remainder;
}
export function serverRunTextMetadata(
  text: string,
): { characterCount: number; utf8Bytes: number } {
  return {
    characterCount: text.length,
    utf8Bytes: Buffer.byteLength(text),
  };
}




function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactTextForAgentRuntime(raw).trim().slice(0, 1_200)
    || 'Agent provider request failed.';
}



interface ActivationState {
  current: ToolActivation;
  tail: Promise<void>;
  followupText: string | null;
}

export interface ServerRunInput {
  readonly messages: ModelMessage[];
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

async function executeBrowserTool(
  run: ServerRun,
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  toolCallId: string,
  activation: ActivationState,
): Promise<unknown> {
  const previous = activation.tail;
  const { promise: next, resolve: release } = Promise.withResolvers<void>();
  activation.tail = next;
  await previous;
  try {
    assertCanonicalToolInvocation(schema, args, activation.current.schemas());
    const argsDigest = digestToolArgs(args);
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
    return shaped.result;
  } finally {
    release();
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
    isEstimated: total.inputTokens === undefined
      || total.outputTokens === undefined,
  };
}

export async function collectServerText(
  run: ServerRun,
  stream: AsyncIterable<string>,
): Promise<string> {
  const extractor = createInlineThinkingExtractor();
  let text = '';
  let pending = '';
  const appendVisible = (visible: string): void => {
    if (!visible) return;
    text += visible;
    pending = flushTextEvents(run, pending + visible, false);
  };
  for await (const delta of stream) {
    appendVisible(extractor.push(delta).text);
  }
  appendVisible(extractor.flush().text);
  flushTextEvents(run, pending, true);
  pushRunEvent(run, 'text-end', serverRunTextMetadata(text));
  return text;
}

async function executeServerTurn(
  input: ServerTurnInput,
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
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
  const text = await collectServerText(input.run, result.textStream);
  const [toolCalls, responseMessages, totalUsage] = await Promise.all([
    result.toolCalls,
    result.responseMessages,
    result.usage,
  ]);
  recordServerContextUsage(
    input.run,
    measuredContextUsage(prepared, totalUsage, text, input.requestIndex),
    schemas.length,
  );
  const continued = toolCalls.length > 0
    || responseMessages.some((message) => message.role === 'tool');
  return {
    messages: continued
      ? [...prepared.messages, ...responseMessages]
      : prepared.messages,
    text,
    followupText: input.activation.followupText,
    continued,
  };
}

function createExecutionPlan(run: ServerRun, input: ServerRunInput) {
  const provider = normalizeLlmProvider(input.provider);
  const apiMode = normalizeOpenAiApiMode(input.openAiApiMode);
  const requested = resolveServerRunToolCatalog(input.tools, run.askOnly);
  const capabilities = resolveModelCapabilities({
    backend: 'api',
    provider,
    modelId: input.model,
  });
  const maxOutputTokens = resolveServerRunMaxOutputTokens(
    input.maxOutputTokens,
    capabilities.maxOutputTokens.value,
    capabilities.contextWindowTokens.value,
  );
  const maxInputTokens = capabilities.maxInputTokens.estimated
    ? Math.max(1, capabilities.contextWindowTokens.value - maxOutputTokens)
    : capabilities.maxInputTokens.value;
  const activation = {
    current: new ToolActivation(
      canonicalServerRunToolCatalog(run.askOnly),
      input.messages,
      requested.map((schema) => schema.name),
    ),
    tail: Promise.resolve(),
    followupText: null,
  };
  const prompt = buildServerRunPrompt({
    ...input,
    projectId: run.projectId,
    askOnly: run.askOnly,
    references: run.references,
  });
  return {
    provider,
    apiMode,
    capabilities,
    maxOutputTokens,
    maxInputTokens,
    activation,
    prompt,
    model: createServerLanguageModel(
      provider,
      input.model,
      apiMode,
      input.origin,
    ),
  };
}

async function executeRunTurns(
  run: ServerRun,
  input: ServerRunInput,
  signal: AbortSignal,
): Promise<void> {
  const plan = createExecutionPlan(run, input);
  let messages = plan.prompt.messages;
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const outcome = await executeServerTurn({
      run,
      messages,
      instructions: plan.prompt.instructions,
      model: plan.model,
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
    });
    if (outcome.followupText) {
      pushRunEvent(run, 'text-delta', { text: outcome.followupText });
      pushRunEvent(run, 'text-end', serverRunTextMetadata(outcome.followupText));
      pushRunEvent(run, 'finish', serverRunTextMetadata(outcome.followupText));
      await setRunStatus(run, 'awaiting-user');
      return;
    }
    messages = outcome.messages;
    if (outcome.continued) continue;
    pushRunEvent(run, 'finish', serverRunTextMetadata(outcome.text));
    await setRunStatus(run, 'completed');
    return;
  }
  pushRunEvent(run, 'max-turns', { turns: MAX_TOOL_TURNS });
  pushRunEvent(run, 'finish', serverRunTextMetadata(''));
  await setRunStatus(run, 'awaiting-user');
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
