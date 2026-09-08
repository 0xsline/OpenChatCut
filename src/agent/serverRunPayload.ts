import { resolveAgentReferences, type AgentContext } from './context';
import type { ProjectDoc } from '../editor/types';
import type { AgentSettings } from './settings/agentSettings';
import { buildAgentSystemPrompt } from './systemPrompt';
import type { AgentModelChoice } from './model-selection';
import { describeImagesForTextModel } from './vision';
import { resolveVisionModel } from './visionConfig';
import { withoutModelImages } from './messages';
import { effectiveOutputTokenBudget, estimateContextTokens } from './context-compaction';
import type { AgentSendOptions } from './useAgentRun';
import { buildServerRunPayload, type ServerRunOptions, type ServerRunPayload } from './serverRunProtocol';

export interface PreparedServerRun {
  readonly payload: ServerRunPayload;
  readonly trimmed: string;
  readonly content: string;
  readonly baseDoc: ProjectDoc;
  readonly modelHistoryLength: number;
  readonly options: ServerRunOptions;
  readonly sendOptions: AgentSendOptions;
}

interface PrepareServerRunInput {
  readonly projectId: string;
  readonly trimmed: string;
  readonly sendOptions: AgentSendOptions;
  readonly settings: AgentSettings;
  readonly ctx: AgentContext;
  readonly options: ServerRunOptions;
  readonly choice: AgentModelChoice;
}

function modelHistoryFor(options: ServerRunOptions, choice: AgentModelChoice) {
  let modelMessages = options.session?.modelMessages() ?? [];
  const supportsImages = choice.capabilities.supportsImages.value;
  const vision = resolveVisionModel(choice);
  if (!supportsImages && vision) {
    return describeImagesForTextModel(modelMessages, vision);
  } else if (!supportsImages) {
    modelMessages = withoutModelImages(modelMessages);
  }
  return modelMessages;
}

export async function buildPreparedServerRun(input: PrepareServerRunInput): Promise<PreparedServerRun> {
  const { projectId, trimmed, sendOptions, settings, ctx, options, choice } = input;
  const entries = resolveAgentReferences(ctx, sendOptions.references ?? []);
  const content = entries.length
    ? `${trimmed}\n\n${JSON.stringify({ type: 'chat_context_entry', entries })}`
    : trimmed;
  const history = modelHistoryFor(options, choice);
  const modelMessages = Array.isArray(history) ? history : await history;
  const systemPrompt = buildAgentSystemPrompt(ctx, settings);
  const estimatedInputTokens = estimateContextTokens(
    [...modelMessages, { role: 'user', content } as (typeof modelMessages)[number]],
    systemPrompt,
  );
  const payload = buildServerRunPayload(projectId, content, sendOptions, {
    history: modelMessages,
    systemPrompt,
    provider: choice.provider,
    model: choice.model,
    backend: choice.backend,
    ...(choice.backend === 'copilot' && choice.reasoningEffort
      ? { reasoningEffort: choice.reasoningEffort } : {}),
    cacheMode: settings.cacheMode,
    autonomousAcceptance: settings.autonomousAcceptance,
    maxAcceptanceIterations: settings.maxAcceptanceIterations,
    maxOutputTokens: effectiveOutputTokenBudget(
      choice.capabilities.maxOutputTokens.value,
      choice.capabilities.contextWindowTokens.value,
      estimatedInputTokens,
    ),
    openAiApiMode: choice.openAiApiMode,
  });
  return {
    payload,
    trimmed,
    content,
    baseDoc: ctx.getDoc(),
    options,
    sendOptions,
    modelHistoryLength: modelMessages.length,
  };
}
