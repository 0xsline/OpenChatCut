import type { ModelMessage } from 'ai';
import type { LlmProtocol } from '../../shared/llm-providers';
import type { AgentEvent } from './runtime';
import type { AgentModelChoice } from './model-selection';
import type { ChatCompletionsMediaPreparation } from './messages';
import {
  makeMessagesPortable,
  prepareChatCompletionsMediaMessages,
  withoutModelImages,
} from './messages';
import { protocolForProvider } from './client';
import { describeImagesForTextModel } from './vision';
import { resolveVisionModel } from './visionConfig';
import { ToolFailureTracker } from './toolFailure';

export class ApiRoundOutput {
  private textStarted = false;
  private bufferedText = '';
  private currentVisibleText = '';
  private followupRequested = false;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly toolFailures: ToolFailureTracker;

  constructor(onEvent: (event: AgentEvent) => void, toolFailures: ToolFailureTracker) {
    this.onEvent = onEvent;
    this.toolFailures = toolFailures;
  }

  readonly emitText = (delta: string): void => {
    this.bufferedText += delta;
  };

  readonly markFollowup = (): void => {
    this.followupRequested = true;
  };

  get visibleText(): string {
    return this.currentVisibleText;
  }

  get askedFollowup(): boolean {
    return this.followupRequested;
  }

  discardBuffered(): void {
    this.bufferedText = '';
  }

  flush(): void {
    if (!this.bufferedText) return;
    const pending = this.bufferedText;
    this.bufferedText = '';
    this.emitVisible(pending);
  }

  failureCompletion(): ModelMessage {
    this.bufferedText = '';
    const report = this.toolFailures.report();
    this.toolFailures.clear();
    this.emitVisible(report);
    return { role: 'assistant', content: report };
  }

  private emitVisible(delta: string): void {
    if (!this.textStarted) {
      this.onEvent({ type: 'text-start' });
      this.textStarted = true;
    }
    this.currentVisibleText += delta;
    this.onEvent({ type: 'text-delta', delta });
  }
}

export interface PreparedApiMessages {
  readonly protocol: LlmProtocol;
  readonly mediaPreparation: ChatCompletionsMediaPreparation;
  readonly requestMessages: ModelMessage[];
  readonly requestCarriesMedia: boolean;
}

export async function prepareApiMessages(
  conv: ModelMessage[],
  choice: AgentModelChoice,
  compatibleMediaFallbackRequired: boolean,
  signal?: AbortSignal,
): Promise<PreparedApiMessages> {
  const protocol = protocolForProvider(choice.provider);
  const mediaPreparation = prepareChatCompletionsMediaMessages(conv);
  const supportsImages = choice.capabilities.supportsImages.value;
  let textOnlyMessages = conv;
  if (!supportsImages) {
    const vision = resolveVisionModel(choice);
    textOnlyMessages = vision
      ? await describeImagesForTextModel(conv, vision, signal)
      : withoutModelImages(conv);
  }
  const requestCarriesMedia = protocol === 'openai-compatible'
    && supportsImages && !compatibleMediaFallbackRequired && mediaPreparation.movedMedia;
  const requestMessages = protocol === 'openai'
    ? makeMessagesPortable(textOnlyMessages, choice.openAiApiMode)
    : protocol === 'openai-compatible' && supportsImages && !compatibleMediaFallbackRequired
      ? mediaPreparation.messages
      : textOnlyMessages;
  return { protocol, mediaPreparation, requestMessages, requestCarriesMedia };
}
