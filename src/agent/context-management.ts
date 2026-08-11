import { generateText, type ModelMessage } from 'ai';
import type { AgentContext } from './context';
import type { AgentModelChoice } from './model-selection';
import {
  effectiveOutputTokenBudget,
  estimateTextTokens,
  estimateContextTokens,
  prepareContext,
  type AgentContextUsage,
  type ContextPreparation,
} from './context-compaction';
import { getLanguageModel, getLanguageModelProviderOptions } from './client';
import { runCodexSummary } from './codex/runtime';
import { activatedToolNamesFromMessages, activationProviderOptions } from './tool-activation';
import { summarizeConversation, SUMMARY_SYSTEM_PROMPT } from './context-summary';


interface AgentContextPreparationOptions {
  readonly messages: readonly ModelMessage[];
  readonly system: string;
  readonly choice: AgentModelChoice;
  readonly ctx: AgentContext;
  readonly tools: readonly unknown[];
  readonly previousUsage?: AgentContextUsage;
  readonly signal?: AbortSignal;
}
export interface AgentContextPreparation extends ContextPreparation {
  readonly maxOutputTokens: number;
}


async function summarizeWithApi(
  prompt: string,
  maxOutputTokens: number,
  choice: AgentModelChoice,
  signal?: AbortSignal,
): Promise<string> {
  const providerOptions = getLanguageModelProviderOptions(choice.provider, choice.openAiApiMode);
  const result = await generateText({
    model: await getLanguageModel(choice.provider, choice.model, choice.openAiApiMode),
    system: SUMMARY_SYSTEM_PROMPT,
    prompt,
    maxOutputTokens,
    maxRetries: 0,
    abortSignal: signal,
    timeout: { totalMs: 90_000 },
    ...(providerOptions ? { providerOptions } : {}),
  });
  return result.text.trim();
}

async function summarizeWithCodex(
  prompt: string,
  maxOutputTokens: number,
  options: AgentContextPreparationOptions,
): Promise<string> {
  return runCodexSummary({
    system: `${SUMMARY_SYSTEM_PROMPT}\nThe response must not exceed ${maxOutputTokens} tokens.`,
    prompt,
    projectId: options.ctx.getProjectId?.().trim() || 'unsaved-project',
    model: options.choice.requestModel,
    reasoningEffort: options.choice.reasoningEffort,
    signal: options.signal,
    maxOutputTokens,
  });
}

export function contextWindowForPreparation(
  choice: AgentModelChoice,
  previous?: AgentContextUsage,
): { readonly tokens: number; readonly estimated: boolean } {
  const resolved = choice.capabilities.contextWindowTokens;
  const reportedCodexWindow = choice.backend === 'codex'
    && resolved.source !== 'settings-override'
    && previous?.modelId === choice.id
    && previous.contextWindowEstimated === false;
  return reportedCodexWindow
    ? { tokens: previous.contextWindowTokens, estimated: false }
    : { tokens: resolved.value, estimated: resolved.estimated };
}
async function summarizeForPreparation(
  messages: readonly ModelMessage[],
  options: AgentContextPreparationOptions,
  contextWindowTokens: number,
  maxInputTokens: number,
  maxOutputTokens: number,
): Promise<string> {
  const summary = await summarizeConversation(
    messages,
    contextWindowTokens,
    maxInputTokens,
    maxOutputTokens,
    (prompt, outputTokens) => options.choice.backend === 'codex'
      ? summarizeWithCodex(prompt, outputTokens, options)
      : summarizeWithApi(prompt, outputTokens, options.choice, options.signal),
  );
  return summary;
}



export async function prepareAgentContext(
  options: AgentContextPreparationOptions,
): Promise<AgentContextPreparation> {
  const contextWindow = contextWindowForPreparation(options.choice, options.previousUsage);
  const contextWindowTokens = contextWindow.tokens;
  const contextWindowEstimated = contextWindow.estimated;
  const maxOutputTokens = effectiveOutputTokenBudget(
    options.choice.capabilities.maxOutputTokens.value,
    contextWindowTokens,
  );
  const resolvedMaxInput = options.choice.capabilities.maxInputTokens;
  const maxInputTokens = resolvedMaxInput.estimated
    ? Math.max(1, contextWindowTokens - maxOutputTokens)
    : resolvedMaxInput.value;
  const toolSchemaTokens = estimateTextTokens(JSON.stringify(options.tools));
  const prepared = await prepareContext({
    messages: options.messages,
    system: options.system,
    modelId: options.choice.id,
    contextWindowTokens,
    contextWindowEstimated,
    maxInputTokens,
    maxOutputTokens,
    requestOverheadTokens: toolSchemaTokens,
    previousUsage: options.previousUsage,
    checkpointProviderOptions: (messages) => (
      activationProviderOptions(activatedToolNamesFromMessages(messages))
    ),
    summarize: (messages) => summarizeForPreparation(
      messages,
      options,
      contextWindowTokens,
      maxInputTokens,
      maxOutputTokens,
    ),
  });
  return {
    ...prepared,
    usage: {
      ...prepared.usage,
      systemTokens: estimateTextTokens(options.system),
      toolSchemaTokens,
      historyTokens: estimateContextTokens(prepared.messages),
      toolCount: options.tools.length,
    },
    maxOutputTokens,
  };
}
