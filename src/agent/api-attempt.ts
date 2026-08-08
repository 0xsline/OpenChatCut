import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { LlmProtocol } from '../../shared/llm-providers';
import type { AgentModelChoice } from './model-selection';
import type { AgentToolSchema } from './tool-schema';
import type { AgentEvent } from './runtime';
import type { ChatCompletionsMediaPreparation } from './messages';
import { createInlineThinkingExtractor } from './settings/agentSettings';
import { estimateContextTokens, estimateTextTokens } from './context-compaction';
import {
  captureSynchronousStart,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './api-retry';
import { ToolFailureTracker } from './toolFailure';

export interface ApiAttemptOptions {
  readonly model: LanguageModel;
  readonly system: string;
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
  readonly providerOptions?: ProviderOptions;
  readonly protocol: LlmProtocol;
  readonly mediaPreparation: ChatCompletionsMediaPreparation;
  readonly requestCarriesMedia: boolean;
  readonly choice: AgentModelChoice;
  readonly contextWasCompacted: boolean;
  readonly toolSchemas: readonly AgentToolSchema[];
  readonly onEvent: (event: AgentEvent) => void;
  readonly onText: (text: string) => void;
  readonly toolFailures: ToolFailureTracker;
}

export interface ApiAttemptOutcome {
  readonly aborted: boolean;
  readonly responseMessages: ModelMessage[];
  readonly compatibleMediaFallbackRequired: boolean;
}

class ApiRequestAttempt {
  private requestMessages: ModelMessage[];
  private requestCarriesMedia: boolean;
  private retriedWithoutMedia = false;
  private retriedTransientRequest = false;
  private aborted = false;
  private outputStarted = false;
  private compatibleMediaFallbackRequired = false;
  private readonly extract = createInlineThinkingExtractor();
  private readonly options: ApiAttemptOptions;

  constructor(options: ApiAttemptOptions) {
    this.options = options;
    this.requestMessages = options.messages;
    this.requestCarriesMedia = options.requestCarriesMedia;
  }

  private retry(error: unknown): boolean {
    if (this.options.signal?.aborted) {
      this.aborted = true;
      return false;
    }
    const retry = {
      retryAttempted: this.retriedWithoutMedia,
      outputStarted: this.outputStarted,
      aborted: this.aborted,
      error,
    };
    if (shouldRetryCompatibleMediaRequest({
      ...retry,
      protocol: this.options.protocol,
      movedMedia: this.requestCarriesMedia,
    })) {
      this.requestMessages = this.options.mediaPreparation.messagesWithoutMedia;
      this.requestCarriesMedia = false;
      this.retriedWithoutMedia = true;
      this.compatibleMediaFallbackRequired = true;
      return true;
    }
    if (shouldRetryTransientAgentRequest({
      ...retry,
      retryAttempted: this.retriedTransientRequest,
    })) {
      this.retriedTransientRequest = true;
      return true;
    }
    throw error;
  }

  private emitUsage(part: Extract<TextStreamPart<ToolSet>, { type: 'finish' }>): void {
    const usage = part.totalUsage;
    if (usage.inputTokens === undefined) return;
    const { choice, contextWasCompacted, system, toolSchemas, onEvent } = this.options;
    onEvent({
      type: 'context-usage',
      usage: {
        inputTokens: usage.inputTokens,
        contextWindowTokens: choice.capabilities.contextWindowTokens.value,
        contextWindowEstimated: choice.capabilities.contextWindowTokens.estimated,
        isEstimated: false,
        modelId: choice.id,
        compacted: contextWasCompacted,
        messageCount: this.requestMessages.length,
        systemTokens: estimateTextTokens(system),
        toolSchemaTokens: estimateTextTokens(JSON.stringify(toolSchemas)),
        historyTokens: estimateContextTokens(this.requestMessages),
        toolCount: toolSchemas.length,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens,
        noCacheInputTokens: usage.inputTokenDetails.noCacheTokens,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
        cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
      },
    });
  }

  private consumePart(part: TextStreamPart<ToolSet>): void {
    const { onEvent, onText, toolFailures } = this.options;
    if (streamPartStartsCompatibleMediaOutput(part.type)) this.outputStarted = true;
    if (part.type === 'text-delta') {
      const extracted = this.extract.push(part.text);
      if (extracted.thinking) onEvent({ type: 'thinking-delta', delta: extracted.thinking });
      if (extracted.text) onText(extracted.text);
    } else if (part.type === 'reasoning-delta' && part.text) {
      onEvent({ type: 'thinking-delta', delta: part.text });
    } else if (part.type === 'tool-input-start') {
      onEvent({ type: 'tool-input-start', name: part.toolName });
    } else if (part.type === 'tool-input-delta' && part.delta) {
      onEvent({ type: 'tool-input-delta', delta: part.delta });
    } else if (part.type === 'tool-result') {
      toolFailures.record(part.toolName, { success: true, result: part.output });
    } else if (part.type === 'tool-error') {
      toolFailures.record(part.toolName, { success: false, result: part.error });
    } else if (part.type === 'error') {
      throw part.error;
    } else if (part.type === 'finish') {
      this.emitUsage(part);
    } else if (part.type === 'abort') {
      this.aborted = true;
    }
  }

  private async consume(stream: AsyncIterable<TextStreamPart<ToolSet>>): Promise<void> {
    for await (const part of stream) {
      this.consumePart(part);
      if (this.aborted) break;
    }
  }

  private flushExtractor(): void {
    const tail = this.extract.flush();
    if (tail.thinking) this.options.onEvent({ type: 'thinking-delta', delta: tail.thinking });
    if (tail.text) this.options.onText(tail.text);
  }

  async run(): Promise<ApiAttemptOutcome> {
    let responseMessages: ModelMessage[] = [];
    for (;;) {
      this.outputStarted = false;
      const started = captureSynchronousStart(() => streamText({
        model: this.options.model,
        system: this.options.system,
        messages: this.requestMessages,
        tools: this.options.tools,
        maxOutputTokens: this.options.maxOutputTokens,
        maxRetries: 0,
        abortSignal: this.options.signal,
        timeout: { stepMs: 120_000, firstChunkMs: 30_000, toolMs: 30_000 },
        ...(this.options.providerOptions ? { providerOptions: this.options.providerOptions } : {}),
      }));
      if (!started.ok) {
        if (this.retry(started.error)) continue;
        break;
      }
      try {
        await this.consume(started.value.stream);
      } catch (error) {
        if (this.retry(error)) continue;
      }
      this.flushExtractor();
      try {
        responseMessages = await started.value.responseMessages;
      } catch (error) {
        if (this.aborted || this.options.signal?.aborted) responseMessages = [];
        else if (this.retry(error)) continue;
      }
      break;
    }
    return {
      aborted: this.aborted,
      responseMessages,
      compatibleMediaFallbackRequired: this.compatibleMediaFallbackRequired,
    };
  }
}

export function runApiRequestAttempt(options: ApiAttemptOptions): Promise<ApiAttemptOutcome> {
  return new ApiRequestAttempt(options).run();
}
