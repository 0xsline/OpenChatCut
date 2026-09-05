import {
  streamText,
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
  resolveCopilotModelCapabilities,
  resolveModelCapabilities,
  type ModelBackend,
  type ModelCapabilities,
} from '../../shared/model-capabilities';
import { getKey } from '../keystore';
import {
  canonicalServerRunToolCatalog,
  resolveServerRunToolCatalog,
} from './tool-policy';
import { createServerLanguageModel, serverProviderOptions } from './model';
import {
  estimateContextTokens,
  estimateTextTokens,
  type AgentContextUsage,
  type ContextPreparation,
} from '../../src/agent/context-compaction';
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
  pushRunEvent,
  recordServerContextUsage,
  setRunStatus,
  type ServerRun,
} from './store';
import { classifyLlmFailure, runServerTurnWithRetry } from './llm-retry';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import {
  collectServerText,
  resolveServerRunMaxOutputTokens,
  serverRunTextMetadata,
} from './executor-events';
import {
  acceptanceInstructions,
  createAcceptanceLoop,
  decideAcceptanceAfterTurn,
  turnDisposition,
} from './acceptance-loop';
import { createServerTools, type ActivationState } from './browser-tool';
export { executeBrowserTool, type ActivationState } from './browser-tool';
export { turnDisposition, type TurnDisposition } from './acceptance-loop';
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
export interface ServerRunInput {
  readonly messages: ModelMessage[];
  readonly backend?: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | null;
  readonly openAiApiMode: OpenAiApiMode;
  readonly cacheMode: 'short' | 'long';
  readonly maxOutputTokens: number;
  readonly autonomousAcceptance: boolean;
  readonly maxAcceptanceIterations: number;
  readonly origin: string;
  readonly tools: readonly AgentToolSchema[];
  readonly instructions?: string;
}

/** Narrow a persisted or request-supplied backend string to the known set. */
export function serverRunBackend(value: unknown): ModelBackend {
  return value === 'codex' || value === 'copilot' ? value : 'api';
}

type ServerTurnInput = Omit<ServerContextInput, 'schemas'> & {
  readonly activation: ActivationState;
  readonly requestIndex: number;
  /** Silent overflow-recovery stage: shrinks the request after a provider rejection. */
  readonly overflowStage?: 'reduced-output';
};

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
    // Recover silently in escalating stages before surfacing anything:
    // 1) compress history (forceCompact), 2) shrink the output reservation,
    // 3) shrink both output and the active tool surface. Each stage only
    // changes the request; the user never sees an intermediate failure.
    // Deterministic retries for other failures live in llm-retry.ts.
    if (input.signal.aborted
      || input.forceCompact
      || classifyLlmFailure(error).code !== 'CONTEXT_WINDOW_EXCEEDED') {
      throw error;
    }
    pushRunEvent(input.run, 'context-overflow-retry', { requestIndex: input.requestIndex });
    try {
      return await runServerTurnOnce({ ...input, forceCompact: true });
    } catch (retryError) {
      if (input.signal.aborted || classifyLlmFailure(retryError).code !== 'CONTEXT_WINDOW_EXCEEDED') {
        throw retryError;
      }
      pushRunEvent(input.run, 'context-overflow-retry', { requestIndex: input.requestIndex, stage: 'reduced-output' });
      return runServerTurnOnce({ ...input, forceCompact: true, overflowStage: 'reduced-output' });
    }
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
  const maxOutputTokens = input.overflowStage === 'reduced-output'
    ? Math.max(4_096, Math.floor(input.maxOutputTokens / 4))
    : input.maxOutputTokens;
  const result = streamText({
    model: input.model,
    instructions: input.instructions,
    messages: prepared.messages,
    tools,
    ...(options ? { providerOptions: options } : {}),
    maxOutputTokens,
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
  backend: ModelBackend,
  modelId: string,
): ModelCapabilities {
  return resolveModelCapabilities(
    { backend, provider, modelId },
    parseModelCapabilityOverrides(getKey(MODEL_CAPABILITY_OVERRIDES_KEY)),
  );
}

/**
 * Copilot publishes exact per-model limits, so prefer them over the bundled
 * catalog; fall back to the catalog path when the runtime is unreachable.
 */
async function resolveCopilotRunCapabilities(
  provider: LlmProvider,
  modelId: string,
): Promise<ModelCapabilities> {
  const overrides = parseModelCapabilityOverrides(getKey(MODEL_CAPABILITY_OVERRIDES_KEY));
  const facts = await (await import('../copilot/client')).copilotModelFacts(modelId)
    .catch(() => null);
  if (!facts) return resolveServerRunCapabilities(provider, 'copilot', modelId);
  return resolveCopilotModelCapabilities(
    { backend: 'copilot', provider, modelId },
    {
      contextWindowTokens: facts.contextWindowTokens,
      maxInputTokens: facts.maxInputTokens,
      maxOutputTokens: facts.maxOutputTokens,
      supportsTools: facts.supportsTools,
      supportsVision: facts.supportsVision,
      reasoningEfforts: facts.supportedReasoningEfforts,
    },
    overrides,
  );
}

async function createExecutionPlan(run: ServerRun, input: ServerRunInput) {
  const provider = normalizeLlmProvider(input.provider);
  const apiMode = normalizeOpenAiApiMode(input.openAiApiMode);
  const backend = serverRunBackend(input.backend);
  const requested = resolveServerRunToolCatalog(input.tools, run.askOnly);
  const capabilities = backend === 'copilot'
    ? await resolveCopilotRunCapabilities(provider, input.model)
    : resolveServerRunCapabilities(provider, backend, input.model);
  const basePrompt = buildServerRunPrompt({
    ...input,
    projectId: run.projectId,
    askOnly: run.askOnly,
    references: run.references,
  });
  const estimatedInputTokens = estimateContextTokens(
    basePrompt.messages,
    basePrompt.instructions,
    estimateTextTokens(JSON.stringify(requested)),
  );
  const maxOutputTokens = resolveServerRunMaxOutputTokens(
    input.maxOutputTokens,
    capabilities.maxOutputTokens.value,
    capabilities.contextWindowTokens.value,
    estimatedInputTokens,
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
    acceptance: createAcceptanceLoop(
      input.autonomousAcceptance && !run.askOnly,
      input.maxAcceptanceIterations,
    ),
  };
  const prompt = {
    ...basePrompt,
    instructions: basePrompt.instructions + acceptanceInstructions(activation.acceptance.enabled),
  };
  return {
    backend,
    provider,
    apiMode,
    capabilities,
    maxOutputTokens,
    maxInputTokens,
    activation,
    prompt,
    model: backend === 'codex' || backend === 'copilot'
      ? undefined
      : createServerLanguageModel(
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
  const plan = await createExecutionPlan(run, input);
  let messages = plan.prompt.messages;
  // No turn cap: the model decides when the task is done. The only automatic
  // stop beside "no more tool calls" is an output-token cutoff, which would
  // otherwise feed truncated text back into the loop.
  for (let turn = 0; ; turn += 1) {
    const subprocessTurnInput = {
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
    };
    const outcome = await runServerTurnWithRetry(run, turn + 1, signal, () =>
      plan.backend === 'codex'
        ? (async () => (await import('./codex-turn'))
          .executeServerCodexTurn(subprocessTurnInput))()
        : plan.backend === 'copilot'
          ? (async () => (await import('./copilot-turn')).executeServerCopilotTurn({
            ...subprocessTurnInput,
            reasoningEffort: input.reasoningEffort ?? null,
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
      if (plan.activation.acceptance.phase === 'checking') {
        pushRunEvent(run, 'acceptance', {
          status: 'paused',
          iteration: plan.activation.acceptance.iteration,
          maxIterations: plan.activation.acceptance.maxIterations,
        });
      }
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
    if (disposition === 'completed') {
      const acceptance = decideAcceptanceAfterTurn(plan.activation.acceptance);
      plan.activation.acceptance = acceptance.state;
      if (acceptance.action === 'continue') {
        pushRunEvent(run, 'acceptance', {
          status: 'checking',
          iteration: acceptance.state.iteration,
          maxIterations: acceptance.state.maxIterations,
        });
        messages = [...messages, acceptance.message];
        continue;
      }
      if (acceptance.action === 'fail') {
        pushRunEvent(run, 'acceptance', {
          status: 'failed',
          iteration: acceptance.state.iteration,
          maxIterations: acceptance.state.maxIterations,
          reason: acceptance.reason,
        });
        throw new Error(acceptance.reason);
      }
      if (acceptance.status === 'passed') {
        pushRunEvent(run, 'acceptance', {
          status: 'passed',
          iteration: acceptance.state.iteration,
          maxIterations: acceptance.state.maxIterations,
        });
      }
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
