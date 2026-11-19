import type { ModelMessage } from 'ai';
import { executeServerApiTurn as executeServerTurn } from './api-turn';
import { pauseInterruptedRun, safeRunError as safeError, settleRunFailure } from './run-continuation-pause';
import {
  normalizeLlmProvider,
  resolveModelRequestPolicy,
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
import { createServerLanguageModel } from './model';
import {
  estimateContextTokens,
  estimateTextTokens,
} from '../../src/agent/context-compaction';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { ToolActivation } from '../../src/agent/tool-activation';
import {
  buildServerRunPrompt,
} from './context';
import {
  pushRunEvent,
  setRunStatus,
  type ServerRun,
} from './store';
import { runServerTurnWithRetry } from './llm-retry';
import { policyForTool } from '../../src/agent/execution-policy';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import {
  resolveServerRunMaxOutputTokens,
  serverRunTextMetadata,
} from './executor-events';
import {
  acceptanceInstructions,
  recordAcceptedTool,
  createAcceptanceLoop,
  decideAcceptanceAfterTurn,
  turnDisposition,
} from './acceptance-loop';
import { type ActivationState } from './browser-tool';
import { RunRecoveryFault, isRunRecoveryFault } from './run-recovery-fault';
import { beginRunRecoveryRuntime, finalizeRunRecovery, assertRunRecoveryAuthority, runRecoveryKeyOf, stopRunRecoveryRuntime } from './run-recovery-runtime';
import { reconcileRestartedToolApprovals } from './store-recovery';
import { settleRunRecoveryFault } from './run-recovery-freeze';
import { runRecoveryStore, supportsDurableRunRecovery, type RunRecoveryRun } from './run-recovery-store';
export { executeBrowserTool, type ActivationState } from './browser-tool';
export { turnDisposition, type TurnDisposition } from './acceptance-loop';
export {
  flushTextEvents,
  collectServerText,
  flushThinkingEvents,
  resolveServerRunMaxOutputTokens,
  serverRunTextMetadata,
} from './executor-events';
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
  /** claude-code only: enforced on that turn's own MCP server, not a model choice. */
  readonly approvalMode?: 'manual' | 'auto';
}

/** Narrow a persisted or request-supplied backend string to the known set. */
export function serverRunBackend(value: unknown): ModelBackend {
  return value === 'codex' || value === 'copilot' || value === 'claude-code' ? value : 'api';
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

async function createExecutionPlan(run: ServerRun, input: ServerRunInput, deps: ExecuteRunDeps) {
  const provider = normalizeLlmProvider(input.provider);
  const apiMode = resolveModelRequestPolicy(provider, input.openAiApiMode, input.cacheMode).apiMode;
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
    model: backend === 'codex' || backend === 'copilot' || backend === 'claude-code'
      ? undefined
      : (deps.createApiModel ?? createServerLanguageModel)(
          provider,
          input.model,
          apiMode,
          input.origin,
        ),
  };
}

export interface ExecuteRunDeps {
  readonly resume?: RunRecoveryRun;
  readonly createApiModel?: typeof createServerLanguageModel;
  readonly executeApiTurn?: typeof executeServerTurn;
  readonly executeCodexTurn?: typeof import('./codex-turn.ts').executeServerCodexTurn;
}

async function executeRunTurns(
  run: ServerRun,
  input: ServerRunInput,
  signal: AbortSignal,
  deps: ExecuteRunDeps = {},
): Promise<void> {
  const plan = await createExecutionPlan(run, input, deps);
  // Every recovered request and tool write shares one owned epoch. Only older
  // runs without a recovery admission keep the legacy in-memory execution.
  const recoveryRuntime = supportsDurableRunRecovery(plan.backend) ? beginRunRecoveryRuntime(run) : null;
  const storedRecovery = supportsDurableRunRecovery(plan.backend) ? runRecoveryStore().load(runRecoveryKeyOf(run)) : null;
  if (storedRecovery && !recoveryRuntime) throw new RunRecoveryFault('ownership-lost', 'Another executor owns this run.');
  const resumed = deps.resume;
  if (resumed?.executionState) {
    plan.activation.current = new ToolActivation(plan.activation.current.allSchemas(),
      resumed.messages ?? input.messages, resumed.executionState.activeToolNames);
    plan.activation.acceptance = resumed.executionState.acceptance as typeof plan.activation.acceptance;
    if (plan.backend === 'api') {
      plan.activation.toolFailures.restore(resumed.executionState.toolFailures);
      plan.activation.lastSuccessfulPureTool = resumed.executionState.lastSuccessfulPureTool;
    }
    for (const tool of resumed.tools.filter((entry) => resumed.requestState !== 'pending'
      && entry.requestIndex === resumed.requestIndex && entry.opSeq > resumed.requestOpBoundary && entry.state === 'outcome')) {
      plan.activation.toolFailures.record(tool.name, { success: tool.success ?? false, result: tool.result });
      if (!tool.success) continue;
      const shaped = plan.activation.current.withToolResult(tool.name, tool.result);
      plan.activation.current = shaped.activation;
      plan.activation.acceptance = recordAcceptedTool(plan.activation.acceptance, policyForTool(tool.name, tool.args ?? {}).effect);
      const followup = tool.result && typeof tool.result === 'object' && '__followup' in tool.result ? tool.result.__followup : null;
      if (typeof followup === 'string') plan.activation.followupText = followup;
    }
  }
  let messages = resumed?.messages ? [...resumed.messages] : plan.prompt.messages;
  const runInstructions = plan.backend === 'api' ? resumed?.instructions ?? plan.prompt.instructions : plan.prompt.instructions;
  const initialRequestIndex = resumed?.requestIndex || 1;
  const checkpointApiRound = (nextRequestIndex: number, nextMessages: readonly ModelMessage[],
    completion?: { status: 'completed' | 'awaiting-user'; text: string }): void => {
    if (plan.backend !== 'api' || !recoveryRuntime) return;
    try {
      runRecoveryStore().completeRequest(runRecoveryKeyOf(run), {
        epoch: recoveryRuntime.epoch,
        nextRequestIndex,
        messages: nextMessages,
        instructions: runInstructions,
        executionState: {
          activeToolNames: plan.activation.current.schemas().map((schema) => schema.name),
          acceptance: plan.activation.acceptance,
          toolFailures: plan.activation.toolFailures.snapshot(),
          lastSuccessfulPureTool: plan.activation.lastSuccessfulPureTool,
        },
        ...(completion ? { completion } : {}),
      });
    } catch (error) { throw new RunRecoveryFault('recovery-write-failed', safeError(error)); }
  };
  // No turn cap: the model decides when the task is done. The only automatic
  // stop beside "no more tool calls" is an output-token cutoff, which would
  // otherwise feed truncated text back into the loop.
  for (let turn = 0; ; turn += 1) {
    const requestIndex = initialRequestIndex + turn;
    // Initial execution state is not a completed model request. In particular,
    // a continued configuration failure already owns a pending request index.
    if (recoveryRuntime && (plan.backend !== 'api' || (turn === 0 && !storedRecovery?.executionState))) {
      assertRunRecoveryAuthority(run);
      try {
        runRecoveryStore().saveExecutionState(runRecoveryKeyOf(run), recoveryRuntime.epoch, {
          activeToolNames: plan.activation.current.schemas().map((schema) => schema.name),
          acceptance: plan.activation.acceptance,
        });
      } catch (error) { throw new RunRecoveryFault('recovery-write-failed', safeError(error)); }
    }
    const subprocessTurnInput = {
      run,
      messages,
      instructions: runInstructions,
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
      requestIndex,
      approvalMode: input.approvalMode,
    };
    let attempt = 0;
    const outcome = await runServerTurnWithRetry(run, requestIndex, signal, async () => {
      if (supportsDurableRunRecovery(plan.backend)) {
        const record = recoveryRuntime ? runRecoveryStore().load(runRecoveryKeyOf(run)) : null;
        const retry = attempt++ > 0;
        if (retry && record?.tools.some((tool) => tool.state === 'claimed')) {
          throw new RunRecoveryFault('outcome-unknown', 'A claimed tool must be reconciled before retrying the subprocess.');
        }
        const replay = record?.requestState === 'inflight'
          && (plan.backend === 'api' ? record.messages !== null : !!record.prompt) && record.requestIndex === requestIndex
          && (retry || (turn === 0 && resumed)) ? record : null;
        const recoverableInput = {
          ...subprocessTurnInput,
          reasoningEffort: input.reasoningEffort ?? null,
          ...(recoveryRuntime ? { recovery: recoveryRuntime.sink } : {}),
          ...(replay ? { resumeFrom: {
            requestIndex: replay.requestIndex,
            throughOpSeq: replay.nextOpSeq - 1,
            requestOptions: replay.requestOptions ?? undefined,
            prompt: replay.prompt ?? '',
            messages: replay.messages ?? undefined,
            instructions: replay.instructions ?? undefined,
            toolNames: replay.toolNames ?? undefined,
            completedTools: replay.tools.filter((tool) => tool.state === 'outcome' && tool.requestIndex === replay.requestIndex && tool.opSeq > replay.requestOpBoundary)
              .map((tool) => ({ ...tool, success: tool.success ?? false, result: tool.result })),
          } } : {}),
        };
        if (plan.backend === 'codex') {
          const executeCodexTurn = deps.executeCodexTurn ?? (await import('./codex-turn')).executeServerCodexTurn;
          return executeCodexTurn(recoverableInput);
        }
        if (plan.backend === 'api') {
          return (deps.executeApiTurn ?? executeServerTurn)({
            ...recoverableInput,
            model: plan.model!,
            provider: plan.provider,
            apiMode: plan.apiMode,
            cacheMode: input.cacheMode,
          });
        }

      }
      if (plan.backend === 'claude-code') {
        return (await import('./claude-code-turn')).executeServerClaudeCodeTurn(subprocessTurnInput);
      }
      return (await import('./copilot-turn')).executeServerCopilotTurn({
        ...subprocessTurnInput,
        reasoningEffort: input.reasoningEffort ?? null,
      });
    });
    if (recoveryRuntime) assertRunRecoveryAuthority(run);
    if (outcome.followupText) {
      checkpointApiRound(requestIndex + 1, outcome.messages, { status: 'awaiting-user', text: outcome.followupText });
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
    const disposition = turnDisposition(outcome.hitMaxTokens, outcome.continued);
    if (disposition === 'continue') {
      checkpointApiRound(requestIndex + 1, messages);
      continue;
    }
    if (disposition === 'max-tokens') {
      pushRunEvent(run, 'max-tokens', { turn: turn + 1 });
      if (recoveryRuntime) {
        checkpointApiRound(requestIndex + 1, messages);
        throw new Error('The model reached its output limit. Send another message to continue this task.');
      }
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
        checkpointApiRound(requestIndex + 1, messages);
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
    if (plan.activation.toolFailures.hasUnresolved) {
      // The model answered with the failed result in its context, so the run completes;
      // this tells the user and the inspector which calls failed, without a failure banner.
      pushRunEvent(run, 'tool-failures', { failures: plan.activation.toolFailures.snapshot() });
    }
    checkpointApiRound(requestIndex + 1, messages, { status: 'completed', text: outcome.text });
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

export async function executeRun(
  run: ServerRun,
  input: ServerRunInput,
  deps: ExecuteRunDeps = {},
): Promise<void> {
  const abort = new AbortController();
  run.abort = abort;
  const recoverable = supportsDurableRunRecovery(serverRunBackend(input.backend));
  try {
    if (recoverable && runRecoveryStore().load(runRecoveryKeyOf(run)) && !beginRunRecoveryRuntime(run)) {
      throw new RunRecoveryFault('ownership-lost', 'Another executor owns this run.');
    }
    run.error = null;
    await setRunStatus(run, 'running');
    const completion = deps.resume?.backend === 'api' ? deps.resume.completion : null;
    if (deps.resume) {
      const runtime = beginRunRecoveryRuntime(run);
      if (!runtime) throw new RunRecoveryFault('ownership-lost', 'Another executor owns this run.');
      if (deps.resume.tools.length) {
        try { await reconcileRestartedToolApprovals(run, runtime.epoch); }
        catch (error) { throw new RunRecoveryFault('recovery-write-failed', safeError(error)); }
      }
    }
    if (completion) {
      assertRunRecoveryAuthority(run);
      if (!run.events.some((event) => event.type === 'finish')) {
        const lastStart = run.events.findLastIndex((event) => event.type === 'text-start');
        const segment = run.events.slice(Math.max(0, lastStart));
        const visible = segment.filter((event) => event.type === 'text-delta')
          .map((event) => String((event.data as { text?: unknown }).text ?? '')).join('');
        const remaining = completion.text.startsWith(visible) ? completion.text.slice(visible.length)
          : visible.endsWith(completion.text) ? '' : completion.text;
        if (remaining) pushRunEvent(run, 'text-delta', { text: remaining });
        if (remaining || !segment.some((event) => event.type === 'text-end')) {
          pushRunEvent(run, 'text-end', serverRunTextMetadata(completion.text));
        }
        pushRunEvent(run, 'finish', serverRunTextMetadata(completion.text));
      }
      await setRunStatus(run, completion.status);
    } else {
      await executeRunTurns(run, input, abort.signal, deps);
    }
    // The terminal write precedes the purge: the run reached a business
    // outcome, so its replay body is no longer needed. Finalizing first would
    // drop the evidence a late crash could still have needed.
    if (recoverable) finalizeRunRecovery(run);
  } catch (error) {
    const failure = isRunRecoveryFault(abort.signal.reason) ? abort.signal.reason : error;
    if (isRunRecoveryFault(failure)) {
      await settleRunRecoveryFault(run, failure);
      return;
    }
    if (recoverable && await pauseInterruptedRun(run, abort, error)) return;
    await settleRunFailure(run, abort, error);
    if (recoverable && !run.persistenceError) finalizeRunRecovery(run);
  } finally {
    if (recoverable) stopRunRecoveryRuntime(run);
    if (run.abort === abort) run.abort = undefined;
  }
}
