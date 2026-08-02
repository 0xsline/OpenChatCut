import {
  jsonSchema,
  streamText,
  tool,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import {
  captureSynchronousStart,
  errorMessage,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './api-retry';
export {
  isCompatibleMediaFallbackError,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './api-retry';
import type { AgentContext } from './context';
import type { AgentModelChoice } from './model-selection';
import { TOOL_SCHEMAS } from './tools';
import {
  getLanguageModel,
  getLanguageModelProviderOptions,
  protocolForProvider,
  PROVIDER,
  OPENAI_API_MODE,
} from './client';
import {
  makeMessagesPortable,
  normalizeLlmMessages,
  prepareChatCompletionsMediaMessages,
} from './messages';
import {
  createInlineThinkingExtractor,
  loadAgentSettings,
  type AgentSettings,
} from './settings/agentSettings';
import type { GuardDecision } from './skills/skillGuard';
import { completeAbortedTurn } from './abortedTurn';
import { executeOpenChatCutTool } from './codex/runtime';
import {
  runtimeGuardForTool,
  type RuntimeGuardRequest,
} from './runtime-guard';
import type {
  AgentEvent,
  LLMMessage,
  RunAgentOptions,
} from './runtime';

const MAX_OUTPUT_TOKENS = 64_000;
const MAX_TOOL_TURNS = 30;
type ToolResultOutput = ToolResultPart['output'];

function toolModelOutput(output: unknown): ToolResultOutput {
  const shaped = output as {
    denied?: boolean;
    note?: string;
    __images?: Array<{ frame: number; base64: string }>;
  } | null;
  if (shaped?.denied) {
    return { type: 'execution-denied', reason: shaped.note ?? 'User denied tool execution.' };
  }
  if (Array.isArray(shaped?.__images)) {
    return {
      type: 'content',
      value: [
        ...shaped.__images.map((image) => ({
          type: 'file' as const,
          data: { type: 'data' as const, data: image.base64 },
          mediaType: 'image/jpeg',
          filename: `timeline-frame-${image.frame}.jpg`,
        })),
        {
          type: 'text' as const,
          text: shaped.note ?? `${shaped.__images.length} frames rendered`,
        },
      ],
    };
  }
  const value = JSON.stringify(output ?? null);
  return { type: 'text', value };
}

function createAgentTools(
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  settings: AgentSettings,
  onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>,
  onFollowup?: () => void,
): ToolSet {
  return Object.fromEntries(TOOL_SCHEMAS.map((schema) => [
    schema.name,
    tool({
      description: schema.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
      ),
      execute: async (input) => (
        await executeOpenChatCutTool(schema, input ?? {}, {
          ctx,
          onEvent,
          settings,
          resolveGuard: runtimeGuardForTool,
          onSkillGuard,
          onFollowup,
        })
      ).result,
      toModelOutput: ({ output }) => toolModelOutput(output),
    }),
  ]));
}

function responseUsedTools(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === 'tool-call'));
}
export async function runApiAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  choice: AgentModelChoice,
  system: string,
  contextWasCompacted: boolean,
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  let conv = normalizeLlmMessages(messages);
  const settings = loadAgentSettings();

  let toolTurns = 0;
  let compatibleMediaFallbackRequired = false;

  for (;;) {
    const extract = createInlineThinkingExtractor();
    let textStarted = false;
    let visibleText = '';
    let askedFollowup = false;
    const emitText = (delta: string) => {
      if (!textStarted) {
        onEvent({ type: 'text-start' });
        textStarted = true;
      }
      visibleText += delta;
      onEvent({ type: 'text-delta', delta });
    };
    const tools = opts?.askOnly
      ? {}
      : createAgentTools(
          ctx,
          onEvent,
          settings,
          opts?.onSkillGuard,
          () => { askedFollowup = true; },
        );

    try {
      // Responses relays do not consistently persist `rs_*` item IDs. Keep
      // OpenAI turns stateless by replaying portable local history and asking
      // the provider not to store the response.
      // Compatible Chat providers keep vendor history intact and move only
      // tool-result media into a supported user attachment message. A provider
      // that rejects the attachment before producing output gets one text-only
      // retry; the original conversation and tool instances stay unchanged.
      const protocol = protocolForProvider(PROVIDER);
      const mediaPreparation = protocol === 'openai-compatible'
        ? prepareChatCompletionsMediaMessages(conv)
        : null;
      let requestCarriesMedia =
        (mediaPreparation?.movedMedia ?? false) && !compatibleMediaFallbackRequired;
      let requestMessages = protocol === 'openai'
        ? makeMessagesPortable(conv, OPENAI_API_MODE)
        : mediaPreparation
          ? compatibleMediaFallbackRequired
            ? mediaPreparation.messagesWithoutMedia
            : mediaPreparation.messages
          : conv;
      const providerOptions = getLanguageModelProviderOptions();
      const model = await getLanguageModel();
      let retriedWithoutMedia = false;
      let retriedTransientRequest = false;
      let aborted = false;
      let responseMessages: ModelMessage[] = [];

      requestAttempt:
      for (;;) {
        let outputStarted = false;
        const started = captureSynchronousStart(() => streamText({
          model,
          system,
          messages: requestMessages,
          tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          abortSignal: opts?.signal,
          ...(providerOptions ? { providerOptions } : {}),
        }));
        if (!started.ok) {
          if (opts?.signal?.aborted) {
            aborted = true;
            break requestAttempt;
          }
          if (shouldRetryCompatibleMediaRequest({
            protocol,
            movedMedia: requestCarriesMedia,
            retryAttempted: retriedWithoutMedia,
            outputStarted,
            aborted,
            error: started.error,
          })) {
            requestMessages = mediaPreparation!.messagesWithoutMedia;
            requestCarriesMedia = false;
            retriedWithoutMedia = true;
            compatibleMediaFallbackRequired = true;
            continue requestAttempt;
          }
          if (shouldRetryTransientAgentRequest({
            retryAttempted: retriedTransientRequest,
            outputStarted,
            aborted,
            error: started.error,
          })) {
            retriedTransientRequest = true;
            continue requestAttempt;
          }
          throw started.error;
        }
        const result = started.value;

        try {
          for await (const part of result.stream) {
            if (streamPartStartsCompatibleMediaOutput(part.type)) outputStarted = true;
            if (part.type === 'text-delta') {
              const extracted = extract.push(part.text);
              if (extracted.thinking) onEvent({ type: 'thinking-delta', delta: extracted.thinking });
              if (extracted.text) emitText(extracted.text);
            } else if (part.type === 'reasoning-delta') {
              if (part.text) onEvent({ type: 'thinking-delta', delta: part.text });
            } else if (part.type === 'tool-input-start') {
              onEvent({ type: 'tool-input-start', name: part.toolName });
            } else if (part.type === 'tool-input-delta') {
              if (part.delta) onEvent({ type: 'tool-input-delta', delta: part.delta });
            } else if (part.type === 'error') {
              throw part.error;
            } else if (part.type === 'finish') {
              const inputTokens = part.totalUsage.inputTokens;
              if (inputTokens !== undefined) {
                onEvent({
                  type: 'context-usage',
                  usage: {
                    inputTokens,
                    contextWindowTokens: choice.contextWindowTokens,
                    contextWindowEstimated: choice.contextWindowEstimated,
                    isEstimated: false,
                    modelId: choice.id,
                    compacted: contextWasCompacted,
                    messageCount: requestMessages.length,
                  },
                });
              }
            } else if (part.type === 'abort') {
              aborted = true;
              break;
            }
          }
        } catch (error) {
          if (opts?.signal?.aborted) {
            aborted = true;
          } else if (shouldRetryCompatibleMediaRequest({
            protocol,
            movedMedia: requestCarriesMedia,
            retryAttempted: retriedWithoutMedia,
            outputStarted,
            aborted,
            error,
          })) {
            requestMessages = mediaPreparation!.messagesWithoutMedia;
            requestCarriesMedia = false;
            retriedWithoutMedia = true;
            compatibleMediaFallbackRequired = true;
            continue requestAttempt;
          } else if (shouldRetryTransientAgentRequest({
            retryAttempted: retriedTransientRequest,
            outputStarted,
            aborted,
            error,
          })) {
            retriedTransientRequest = true;
            continue requestAttempt;
          } else {
            throw error;
          }
        }

        const tail = extract.flush();
        if (tail.thinking) onEvent({ type: 'thinking-delta', delta: tail.thinking });
        if (tail.text) emitText(tail.text);

        try {
          responseMessages = await result.responseMessages;
        } catch (error) {
          if (aborted || opts?.signal?.aborted) {
            responseMessages = [];
          } else if (shouldRetryCompatibleMediaRequest({
            protocol,
            movedMedia: requestCarriesMedia,
            retryAttempted: retriedWithoutMedia,
            outputStarted,
            aborted,
            error,
          })) {
            requestMessages = mediaPreparation!.messagesWithoutMedia;
            requestCarriesMedia = false;
            retriedWithoutMedia = true;
            compatibleMediaFallbackRequired = true;
            continue requestAttempt;
          } else if (shouldRetryTransientAgentRequest({
            retryAttempted: retriedTransientRequest,
            outputStarted,
            aborted,
            error,
          })) {
            retriedTransientRequest = true;
            continue requestAttempt;
          } else {
            throw error;
          }
        }
        break requestAttempt;
      }

      if (aborted || opts?.signal?.aborted) {
        const persisted = responseMessages.length || !visibleText
          ? responseMessages
          : [{ role: 'assistant', content: [{ type: 'text', text: visibleText }] } as ModelMessage];
        return completeAbortedTurn(conv, persisted);
      }
      conv = [...conv, ...responseMessages];
      if (askedFollowup) return conv;
      if (!responseUsedTools(responseMessages)) return conv;

      if (++toolTurns >= MAX_TOOL_TURNS) {
        onEvent({ type: 'max-turns', turns: toolTurns });
        return conv;
      }
    } catch (error) {
      if (opts?.signal?.aborted) return conv;
      const message = errorMessage(error).trim();
      onEvent({ type: 'error', message });
      return conv;
    }
  }
}
