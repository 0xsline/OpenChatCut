import type { ModelMessage } from 'ai';
import type { AgentContext } from './context';
import type { CodexAgentToolSpec } from '../../shared/codex-agent';
import type { AgentRunRecorder } from './runtime-ledger';
import type { HarnessToolExecutionContext } from './harness-context';
import { TOOL_SCHEMAS } from './tools';
import { ASK_MODE_TOOL_SCHEMAS } from './ask-mode-tools';
import { buildAgentSystemPrompt } from './systemPrompt';
import { normalizeLlmMessages } from './messages';
import { loadAgentSettings, type AgentSettings } from './settings/agentSettings';
import type { GuardDecision } from './skills/costGuard';
import {
  runtimeGuardForTool,
  type RuntimeGuardRequest,
} from './runtime-guard';
import {
  getActiveAgentModelChoice,
  type AgentModelChoice,
} from './model-selection';
import { executeOpenChatCutTool, runCodexAgent, type CodexToolExecution } from './codex/runtime';
import { prepareAgentContext, type AgentContextPreparation } from './context-management';
import {
  ContextIntegrityError,
  estimateContextTokens,
  estimateTextTokens,
  verifyCanonicalContextCheckpoint,
  type AgentContextUsage,
} from './context-compaction';
import { runApiAgent } from './api-runtime';
import type { ToolFailureTracker } from './toolFailure';
import { ToolActivation } from './tool-activation';
import { assertValidAgentToolSchemas } from './execution-policy';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  sha256Text,
  type AgentRunContext,
} from '../persist/agentRuntimeStore';

export {
  apiToolExecutionOutput,
  isCompatibleMediaFallbackError,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './api-runtime';
export { runtimeGuardForTool } from './runtime-guard';
export type { RuntimeGuardRequest } from './runtime-guard';
export type LLMMessage = ModelMessage;
export interface AgentRuntimeModule {
  runAgent: typeof runAgent;
}
export interface RuntimeContextUpdate {
  readonly messages: ModelMessage[];
  readonly compacted: boolean;
}
export type RuntimeContextPreparer = (
  messages: readonly ModelMessage[],
  tools: readonly unknown[],
) => Promise<RuntimeContextUpdate>;
export type ProviderContextUsageRecorder = (
  usage: AgentContextUsage,
  schemas: readonly unknown[],
) => Promise<void>;
export interface RunAgentOptions {
  readonly askOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>;
  readonly previousContextUsage?: AgentContextUsage;
  readonly toolFailures?: ToolFailureTracker;
  /** Internal per-request registry state; callers normally leave this unset. */
  readonly toolActivation?: ToolActivation;
  readonly prepareContextForTools?: RuntimeContextPreparer;
  readonly recordProviderContextUsage?: ProviderContextUsageRecorder;
  readonly runRecorder?: AgentRunRecorder;
}

export type AgentEvent =
  | { type: 'text-start' }
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'tool-input-start'; name: string }
  | { type: 'tool-input-delta'; delta: string }
  | { type: 'tool'; name: string; args: unknown; result: unknown }
  | { type: 'max-turns'; turns: number }
  | { type: 'context-usage'; usage: AgentContextUsage }
  | { type: 'error'; message: string };

export function initialMessages(): LLMMessage[] {
  return [];
}
export async function validateCheckpointHistory(
  messages: readonly ModelMessage[],
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!projectId) {
    await verifyCanonicalContextCheckpoint(messages, [], async () => null);
    return undefined;
  }
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const marker = await verifyCanonicalContextCheckpoint(
    messages,
    sidecar.checkpoints,
    (sourceArtifactId) => loadAgentArtifact(projectId, sourceArtifactId),
  );
  return marker?.checkpointId;
}
export interface AgentRequestShapeInput {
  readonly system: string;
  readonly backend: string;
  readonly modelId: string;
  readonly schemas: readonly unknown[];
  readonly checkpointId?: string;
}
export async function computeAgentRequestShapeFingerprint(
  input: AgentRequestShapeInput,
): Promise<{
  requestShapeHash: string;
  systemTokens: number;
  toolSchemaChars: number;
  systemDigest: string;
  toolSchemaDigest: string;
}> {
  const schemaText = JSON.stringify(input.schemas);
  const systemTokens = estimateTextTokens(input.system);
  const shape = {
    backend: input.backend,
    modelId: input.modelId,
    systemTokens,
    systemDigest: await sha256Text(input.system),
    toolNames: input.schemas.map((schema) => (
      schema && typeof schema === 'object' && 'name' in schema ? String(schema.name) : ''
    )),
    toolSchemaChars: schemaText.length,
    toolSchemaDigest: await sha256Text(schemaText),
    checkpointId: input.checkpointId,
  };
  return {
    requestShapeHash: await sha256Text(JSON.stringify(shape)),
    systemTokens,
    toolSchemaChars: schemaText.length,
    systemDigest: shape.systemDigest,
    toolSchemaDigest: shape.toolSchemaDigest,
  };
}
async function contextRecord(
  system: string,
  choice: AgentModelChoice,
  schemas: readonly unknown[],
  usage: AgentContextUsage,
  checkpointId?: string,
): Promise<AgentRunContext> {
  const fingerprint = await computeAgentRequestShapeFingerprint({
    system, backend: choice.backend, modelId: choice.id, schemas, checkpointId,
  });
  return {
    ...fingerprint,
    modelId: choice.id,
    toolSchemaCount: schemas.length,
    activeToolCount: schemas.length,
    historyTokens: usage.historyTokens,
    checkpointId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    noCacheTokens: usage.noCacheInputTokens,
    cacheTtlMs: usage.cacheTtlMs,
    requestIndex: usage.requestIndex,
    attemptIndex: usage.attemptIndex,
    retryCount: usage.retryCount,
    retryReasons: usage.retryReasons,
    mediaInputCount: usage.mediaInputCount,
    mediaTokenEstimate: usage.mediaTokenEstimate,
  };
}


const toCodexToolSpec = (schema: (typeof TOOL_SCHEMAS)[number]): CodexAgentToolSpec => ({
  name: schema.name,
  description: schema.description,
  inputSchema: schema.input_schema,
});
interface RuntimeCheckpointState {
  checkpointId?: string;
}
function createContextRepreparer(
  system: string,
  choice: AgentModelChoice,
  ctx: AgentContext,
  initialUsage: AgentContextUsage,
  onEvent: (event: AgentEvent) => void,
  checkpointState: RuntimeCheckpointState,
  recorder?: AgentRunRecorder,
  signal?: AbortSignal,
): RuntimeContextPreparer {
  let previousUsage = initialUsage;
  return async (messages, tools) => {
    const prepared = await prepareAgentContext({
      messages, system, choice, ctx, tools, previousUsage, signal,
    });
    if (prepared.checkpoint) {
      checkpointState.checkpointId = prepared.checkpoint.checkpointId;
      if (recorder) await recorder.recordCheckpoint(prepared.checkpoint);
    }
    if (recorder) {
      await recorder.recordContext(await contextRecord(
        system, choice, tools, prepared.usage, checkpointState.checkpointId,
      ));
    }
    previousUsage = prepared.usage;
    onEvent({ type: 'context-usage', usage: prepared.usage });
    return { messages: prepared.messages, compacted: prepared.usage.compacted };
  };
}
export interface CodexToolRequest {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly activation: ToolActivation;
  readonly ctx: AgentContext;
  readonly onEvent: (event: AgentEvent) => void;
  readonly settings: AgentSettings;
  readonly onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>;
  readonly runRecorder?: AgentRunRecorder;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
  readonly harness?: HarnessToolExecutionContext;
  readonly onFollowup?: (text: string) => void;
}

export async function executeCodexTool(request: CodexToolRequest): Promise<{
  readonly activation: ToolActivation;
  readonly execution: CodexToolExecution;
}> {
  const {
    name, args, activation, ctx, onEvent, settings, onSkillGuard, runRecorder,
    toolCallId, signal, harness, onFollowup,
  } = request;
  const schema = activation.allSchemas().find((candidate) => candidate.name === name);
  if (!schema) {
    return {
      activation,
      execution: { success: false, result: { error: `Unknown Codex tool: ${name}` } },
    };
  }
  const execution = await executeOpenChatCutTool(schema, args, {
    ctx,
    onEvent,
    settings,
    resolveGuard: runtimeGuardForTool,
    onSkillGuard,
    toolCatalog: activation.allSchemas(),
    activeToolCatalog: activation.schemas(),
    harness,
    runRecorder,
    toolCallId,
    signal,
    onFollowup,
  });
  if ((name !== 'ToolSearch' && name !== 'load_skill') || !execution.success) {
    return { activation, execution };
  }
  const activated = activation.withToolResult(name, execution.result);
  return {
    activation: activated.activation,
    execution: {
      ...execution,
      result: activated.result,
      refreshTools: activated.activation.names().length > activation.names().length,
    },
  };
}


interface CodexBackendInput {
  readonly messages: LLMMessage[];
  readonly ctx: AgentContext;
  readonly onEvent: (event: AgentEvent) => void;
  readonly choice: AgentModelChoice;
  readonly system: string;
  readonly contextWasCompacted: boolean;
  readonly contextWindowTokens: number;
  readonly contextWindowEstimated: boolean;
  readonly maxOutputTokens: number;
  readonly activation: ToolActivation;
  readonly opts?: RunAgentOptions;
}

async function runCodexBackend(input: CodexBackendInput): Promise<LLMMessage[]> {
  const {
    messages, ctx, onEvent, choice, system, contextWasCompacted,
    contextWindowTokens, contextWindowEstimated, maxOutputTokens, activation, opts,
  } = input;
  const settings = loadAgentSettings();
  let currentActivation = activation;
  const resolveTools = () => currentActivation.schemas().map(toCodexToolSpec);
  return runCodexAgent(messages, ctx, onEvent, {
    askOnly: opts?.askOnly,
    signal: opts?.signal,
    model: choice.requestModel,
    reasoningEffort: choice.reasoningEffort,
    modelId: choice.id,
    contextWindowTokens,
    contextWindowEstimated,
    contextWindowOverride: choice.capabilities.contextWindowTokens.source === 'settings-override',
    maxOutputTokens,
    maxInputTokens: choice.capabilities.maxInputTokens.estimated
      ? Math.max(1, contextWindowTokens - maxOutputTokens)
      : choice.capabilities.maxInputTokens.value,
    supportsImages: choice.capabilities.supportsImages.value,
    requestMessageCount: messages.length,
    system,
    onContextUsage: opts?.recordProviderContextUsage,
    contextWasCompacted,
    toolFailures: opts?.toolFailures,
    systemTokens: estimateTextTokens(system),
    toolSchemaTokens: estimateTextTokens(JSON.stringify(currentActivation.schemas())),
    historyTokens: estimateContextTokens(messages),
    toolCount: currentActivation.schemas().length,
    tools: resolveTools(),
    resolveTools,
    prepareContextForTools: opts?.prepareContextForTools,
    executeTool: async (name, args, toolCallId, signal, harness, onFollowup) => {
      const update = await executeCodexTool({
        name, args, activation: currentActivation, ctx, onEvent, settings,
        onSkillGuard: opts?.onSkillGuard, runRecorder: opts?.runRecorder,
        toolCallId, signal, harness, onFollowup,
      });
      currentActivation = update.activation;
      return update.execution;
    },
  });
}
async function runPreparedAgent(
  prepared: AgentContextPreparation,
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  active: AgentModelChoice,
  system: string,
  activation: ToolActivation,
  checkpointId: string | undefined,
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  const checkpointState: RuntimeCheckpointState = { checkpointId };
  const recorder = opts?.runRecorder;
  const recordProviderContextUsage: ProviderContextUsageRecorder | undefined = recorder
    ? async (usage, schemas) => {
        await recorder.recordContextUsage(await contextRecord(
          system, active, schemas, usage, checkpointState.checkpointId,
        ));
      }
    : opts?.recordProviderContextUsage;
  const runtimeOptions: RunAgentOptions = {
    ...opts,
    toolActivation: activation,
    recordProviderContextUsage,
    prepareContextForTools: createContextRepreparer(
      system, active, ctx, prepared.usage, onEvent,
      checkpointState, recorder, opts?.signal,
    ),
  };
  if (active.backend !== 'codex') {
    return runApiAgent(
      prepared.messages, ctx, onEvent, active, system,
      prepared.usage.compacted, prepared.maxOutputTokens, runtimeOptions,
    );
  }
  return runCodexBackend({
    messages: prepared.messages,
    ctx,
    onEvent,
    choice: active,
    system,
    contextWasCompacted: prepared.usage.compacted,
    contextWindowTokens: prepared.usage.contextWindowTokens,
    contextWindowEstimated: prepared.usage.contextWindowEstimated,
    maxOutputTokens: prepared.maxOutputTokens,
    activation,
    opts: runtimeOptions,
  });
}

/**
 * Browser-side Agent loop. Server-side execution (serverRun) is the only Agent
 * run path since the server-only refactor; this loop and its api/codex backends
 * have no runtime consumer and are kept solely as regression-test assets
 * (token-efficiency.verify, runtime.verify, followup-activation.verify).
 */
export async function runAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  const conv = normalizeLlmMessages(messages);
  const active = getActiveAgentModelChoice();
  if (!active) {
    onEvent({ type: 'error', message: 'No Agent model is available.' });
    return conv;
  }
  const toolsAvailable = active.capabilities.supportsTools.value;
  const system = buildAgentSystemPrompt(ctx, { toolsAvailable });
  const toolCatalog = !toolsAvailable ? [] : opts?.askOnly ? ASK_MODE_TOOL_SCHEMAS : TOOL_SCHEMAS;
  const activation = new ToolActivation(toolCatalog, conv);
  try {
    assertValidAgentToolSchemas(toolCatalog);
    const validatedCheckpointId = await validateCheckpointHistory(conv, ctx.getProjectId?.());
    const prepared = await prepareAgentContext({
      messages: conv, system, choice: active, ctx, tools: activation.schemas(),
      previousUsage: opts?.previousContextUsage, signal: opts?.signal,
    });
    const checkpointId = prepared.checkpoint?.checkpointId ?? validatedCheckpointId;
    onEvent({ type: 'context-usage', usage: prepared.usage });
    const result = await runPreparedAgent(
      prepared, ctx, onEvent, active, system, activation, checkpointId, opts,
    );
    return result;
  } catch (error) {
    const aborted = opts?.signal?.aborted === true;
    const message = error instanceof Error ? error.message : String(error);
    if (aborted) return conv;
    const prefix = error instanceof ContextIntegrityError ? 'context_integrity' : 'Unable to prepare model context';
    onEvent({ type: 'error', message: `${prefix}: ${message}` });
    return conv;
  }
}

