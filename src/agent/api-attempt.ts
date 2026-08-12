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
import {
  countContextMedia,
  estimateContextTokens,
  estimateTextTokens,
  MODEL_MEDIA_TOKEN_ESTIMATE,
  type AgentContextUsage,
} from './context-compaction';
import {
  captureSynchronousStart,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './api-retry';
import { ToolFailureTracker } from './toolFailure';

/**
 * AI SDK tool-execution timeout. `toolMs` remains the fail-fast default for
 * every tool, while the SDK's per-tool override grants only on-device
 * transcription enough time for model load and inference. wasm base runs at
 * RTF ~0.35 (a 15-min clip ≈ 5 min), small at RTF ~0.9 (15-min clip ≈ 13
 * min); 15 minutes covers both while still bounding a stuck worker.
 */
export const AGENT_TOOL_TIMEOUTS = {
  toolMs: 30_000,
  tools: {
    transcribe_trackMs: 900_000,
  },
} as const;

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
  readonly requestIndex: number;
  readonly cacheTtlMs?: number;
  readonly toolSchemas: readonly AgentToolSchema[];
  readonly onEvent: (event: AgentEvent) => void;
  readonly onContextUsage?: (usage: AgentContextUsage) => Promise<void>;
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
  private attemptIndex = 0;
  private readonly retryReasons: string[] = [];
  private readonly extract = createInlineThinkingExtractor();
  private responseText = '';
  private reasoningText = '';
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
      this.retryReasons.push('media_compatibility');
      return true;
    }
    if (shouldRetryTransientAgentRequest({
      ...retry,
      retryAttempted: this.retriedTransientRequest,
    })) {
      this.retriedTransientRequest = true;
      this.retryReasons.push('transient_transport');
      return true;
    }
    throw error;
  }

  private async emitUsage(
    part: Extract<TextStreamPart<ToolSet>, { type: 'finish' }>,
  ): Promise<void> {
    const usage = part.totalUsage;
    const { choice, contextWasCompacted, system, toolSchemas, onEvent } = this.options;
    const estimatedInputTokens = estimateTextTokens(system)
      + estimateTextTokens(JSON.stringify(toolSchemas))
      + estimateContextTokens(this.requestMessages);
    const inputTokens = usage.inputTokens ?? estimatedInputTokens;
    const outputTokens = usage.outputTokens ?? estimateTextTokens(this.responseText);
    const reasoningTokens = usage.outputTokenDetails.reasoningTokens
      ?? (this.reasoningText ? estimateTextTokens(this.reasoningText) : undefined);
    const mediaInputCount = countContextMedia(this.requestMessages);
    const contextUsage: AgentContextUsage = {
      inputTokens,
      contextWindowTokens: choice.capabilities.contextWindowTokens.value,
      contextWindowEstimated: choice.capabilities.contextWindowTokens.estimated,
      isEstimated: usage.inputTokens === undefined || usage.outputTokens === undefined,
      modelId: choice.id,
      compacted: contextWasCompacted,
      messageCount: this.requestMessages.length,
      systemTokens: estimateTextTokens(system),
      toolSchemaTokens: estimateTextTokens(JSON.stringify(toolSchemas)),
      historyTokens: estimateContextTokens(this.requestMessages),
      toolCount: toolSchemas.length,
      outputTokens,
      reasoningTokens,
      noCacheInputTokens: usage.inputTokenDetails.noCacheTokens,
      cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
      cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
      cacheTtlMs: this.options.cacheTtlMs,
      requestIndex: this.options.requestIndex,
      attemptIndex: this.attemptIndex,
      retryCount: this.retryReasons.length,
      retryReasons: [...this.retryReasons],
      mediaInputCount,
      mediaTokenEstimate: mediaInputCount * MODEL_MEDIA_TOKEN_ESTIMATE,
    };
    onEvent({ type: 'context-usage', usage: contextUsage });
    await this.options.onContextUsage?.(contextUsage);
  }

  private async consumePart(part: TextStreamPart<ToolSet>): Promise<void> {
    const { onEvent, onText, toolFailures } = this.options;
    if (streamPartStartsCompatibleMediaOutput(part.type)) this.outputStarted = true;
    if (part.type === 'text-delta') {
      this.responseText += part.text;
      const extracted = this.extract.push(part.text);
      if (extracted.thinking) {
        this.reasoningText += extracted.thinking;
        onEvent({ type: 'thinking-delta', delta: extracted.thinking });
      }
      if (extracted.text) onText(extracted.text);
    } else if (part.type === 'reasoning-delta' && part.text) {
      this.responseText += part.text;
      this.reasoningText += part.text;
      onEvent({ type: 'thinking-delta', delta: part.text });
    } else if (part.type === 'tool-input-start') {
      onEvent({ type: 'tool-input-start', name: part.toolName });
    } else if (part.type === 'tool-input-delta' && part.delta) {
      this.responseText += part.delta;
      onEvent({ type: 'tool-input-delta', delta: part.delta });
    } else if (part.type === 'tool-result') {
      toolFailures.record(part.toolName, { success: true, result: part.output });
    } else if (part.type === 'tool-error') {
      toolFailures.record(part.toolName, { success: false, result: part.error });
    } else if (part.type === 'error') {
      throw part.error;
    } else if (part.type === 'finish') {
      await this.emitUsage(part);
    } else if (part.type === 'abort') {
      this.aborted = true;
    }
  }

  private async consume(stream: AsyncIterable<TextStreamPart<ToolSet>>): Promise<void> {
    for await (const part of stream) {
      await this.consumePart(part);
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
      this.attemptIndex += 1;
      this.outputStarted = false;
      const started = captureSynchronousStart(() => streamText({
        model: this.options.model,
        system: this.options.system,
        messages: this.requestMessages,
        tools: this.options.tools,
        maxOutputTokens: this.options.maxOutputTokens,
        maxRetries: 0,
        abortSignal: this.options.signal,
        timeout: {
          stepMs: 120_000,
          firstChunkMs: 30_000,
          ...AGENT_TOOL_TIMEOUTS,
        },
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
