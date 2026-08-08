import type { ModelMessage } from 'ai';
import type { AgentContext } from './context';
import type { CodexAgentToolSpec } from '../../shared/codex-agent';
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
import { estimateContextTokens, estimateTextTokens, type AgentContextUsage } from './context-compaction';
import { runApiAgent } from './api-runtime';
import type { ToolFailureTracker } from './toolFailure';
import { ToolActivation } from './tool-activation';

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
export interface RunAgentOptions {
  readonly askOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>;
  readonly previousContextUsage?: AgentContextUsage;
  readonly toolFailures?: ToolFailureTracker;
  /** Internal per-request registry state; callers normally leave this unset. */
  readonly toolActivation?: ToolActivation;
  readonly prepareContextForTools?: RuntimeContextPreparer;
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


const toCodexToolSpec = (schema: (typeof TOOL_SCHEMAS)[number]): CodexAgentToolSpec => ({
  name: schema.name,
  description: schema.description,
  inputSchema: schema.input_schema,
});
function createContextRepreparer(
  system: string,
  choice: AgentModelChoice,
  ctx: AgentContext,
  initialUsage: AgentContextUsage,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): RuntimeContextPreparer {
  let previousUsage = initialUsage;
  return async (messages, tools) => {
    const prepared = await prepareAgentContext({
      messages, system, choice, ctx, tools, previousUsage, signal,
    });
    previousUsage = prepared.usage;
    onEvent({ type: 'context-usage', usage: prepared.usage });
    return { messages: prepared.messages, compacted: prepared.usage.compacted };
  };
}
interface CodexToolRequest {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly activation: ToolActivation;
  readonly ctx: AgentContext;
  readonly onEvent: (event: AgentEvent) => void;
  readonly settings: AgentSettings;
  readonly onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>;
}

async function executeCodexTool(request: CodexToolRequest): Promise<{
  readonly activation: ToolActivation;
  readonly execution: CodexToolExecution;
}> {
  const { name, args, activation, ctx, onEvent, settings, onSkillGuard } = request;
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
  });
  if (name !== 'ToolSearch' || !execution.success) return { activation, execution };
  const activated = activation.withSearchResult(execution.result);
  return {
    activation: activated.activation,
    execution: {
      ...execution,
      result: activated.result,
      refreshTools: activated.activation.names().length > activation.names().length,
    },
  };
}


async function runCodexBackend(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  choice: AgentModelChoice,
  system: string,
  contextWasCompacted: boolean,
  contextWindowTokens: number,
  contextWindowEstimated: boolean,
  maxOutputTokens: number,
  activation: ToolActivation,
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
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
    supportsImages: choice.capabilities.supportsImages.value,
    requestMessageCount: messages.length,
    system,
    contextWasCompacted,
    toolFailures: opts?.toolFailures,
    systemTokens: estimateTextTokens(system),
    toolSchemaTokens: estimateTextTokens(JSON.stringify(currentActivation.schemas())),
    historyTokens: estimateContextTokens(messages),
    toolCount: currentActivation.schemas().length,
    tools: resolveTools(),
    resolveTools,
    prepareContextForTools: opts?.prepareContextForTools,
    executeTool: async (name, args) => {
      const update = await executeCodexTool({
        name, args, activation: currentActivation, ctx, onEvent, settings,
        onSkillGuard: opts?.onSkillGuard,
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
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  const runtimeOptions = {
    ...opts,
    toolActivation: activation,
    prepareContextForTools: createContextRepreparer(
      system, active, ctx, prepared.usage, onEvent, opts?.signal,
    ),
  };
  if (active.backend !== 'codex') {
    return runApiAgent(
      prepared.messages, ctx, onEvent, active, system,
      prepared.usage.compacted, prepared.maxOutputTokens, runtimeOptions,
    );
  }
  return runCodexBackend(
    prepared.messages, ctx, onEvent, active, system,
    prepared.usage.compacted,
    prepared.usage.contextWindowTokens,
    prepared.usage.contextWindowEstimated,
    prepared.maxOutputTokens,
    activation,
    runtimeOptions,
  );
}

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
  const system = buildAgentSystemPrompt(ctx);
  const toolCatalog = !active.capabilities.supportsTools.value
    ? []
    : opts?.askOnly ? ASK_MODE_TOOL_SCHEMAS : TOOL_SCHEMAS;
  const activation = new ToolActivation(toolCatalog, conv);
  try {
    const prepared = await prepareAgentContext({
      messages: conv,
      system,
      choice: active,
      ctx,
      tools: activation.schemas(),
      previousUsage: opts?.previousContextUsage,
      signal: opts?.signal,
    });
    onEvent({ type: 'context-usage', usage: prepared.usage });
    return runPreparedAgent(prepared, ctx, onEvent, active, system, activation, opts);
  } catch (error) {
    if (opts?.signal?.aborted) return conv;
    const message = error instanceof Error ? error.message : String(error);
    onEvent({ type: 'error', message: `Unable to prepare model context: ${message}` });
    return conv;
  }
}

