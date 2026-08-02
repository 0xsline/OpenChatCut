import type { ModelMessage } from 'ai';
import type { AgentContext } from './context';
import type { CodexAgentToolSpec } from '../../shared/codex-agent';
import { TOOL_SCHEMAS } from './tools';
import { buildAgentSystemPrompt } from './systemPrompt';
import { normalizeLlmMessages } from './messages';
import { loadAgentSettings } from './settings/agentSettings';
import type { GuardDecision } from './skills/skillGuard';
import {
  runtimeGuardForTool,
  type RuntimeGuardRequest,
} from './runtime-guard';
import {
  getActiveAgentModelChoice,
  type AgentModelChoice,
} from './model-selection';
import { executeOpenChatCutTool, runCodexAgent } from './codex/runtime';
import { prepareAgentContext } from './context-management';
import type { AgentContextUsage } from './context-compaction';
import { runApiAgent } from './api-runtime';

export {
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
export interface RunAgentOptions {
  readonly askOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>;
  readonly previousContextUsage?: AgentContextUsage;
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


const CODEX_TOOL_SPECS: readonly CodexAgentToolSpec[] = TOOL_SCHEMAS.map((schema) => ({
  name: schema.name,
  description: schema.description,
  inputSchema: schema.input_schema,
}));

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
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  const settings = loadAgentSettings();
  const tools = opts?.askOnly || !choice.capabilities.supportsTools.value ? [] : CODEX_TOOL_SPECS;
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
    tools,
    executeTool: async (name, args) => {
      const schema = TOOL_SCHEMAS.find((candidate) => candidate.name === name);
      if (!schema) return { success: false, result: { error: `Unknown Codex tool: ${name}` } };
      return executeOpenChatCutTool(schema, args, {
        ctx,
        onEvent,
        settings,
        resolveGuard: runtimeGuardForTool,
        onSkillGuard: opts?.onSkillGuard,
      });
    },
  });
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
  const toolSchemas = opts?.askOnly || !active.capabilities.supportsTools.value ? [] : TOOL_SCHEMAS;
  try {
    const prepared = await prepareAgentContext({
      messages: conv,
      system,
      choice: active,
      ctx,
      tools: toolSchemas,
      previousUsage: opts?.previousContextUsage,
      signal: opts?.signal,
    });
    onEvent({ type: 'context-usage', usage: prepared.usage });
    return active.backend === 'codex'
      ? runCodexBackend(
          prepared.messages,
          ctx,
          onEvent,
          active,
          system,
          prepared.usage.compacted,
          prepared.usage.contextWindowTokens,
          prepared.usage.contextWindowEstimated,
          prepared.maxOutputTokens,
          opts,
        )
      : runApiAgent(
          prepared.messages,
          ctx,
          onEvent,
          active,
          system,
          prepared.usage.compacted,
          prepared.maxOutputTokens,
          opts,
        );
  } catch (error) {
    if (opts?.signal?.aborted) return conv;
    const message = error instanceof Error ? error.message : String(error);
    onEvent({ type: 'error', message: `Unable to prepare model context: ${message}` });
    return conv;
  }
}

