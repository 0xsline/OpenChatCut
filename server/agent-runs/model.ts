import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createAlibaba } from '@ai-sdk/alibaba';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import type {
  LanguageModelV4,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { AgentCacheMode } from '../../src/agent/settings/agentSettings';
import {
  resolveModelRequestPolicy,
  type LlmProvider,
  type OpenAiApiMode,
} from '../../shared/llm-providers';

function proxyOptions(provider: LlmProvider, origin: string): {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
} {
  return {
    baseURL: `${origin}/llm`,
    apiKey: 'proxy-injects-the-real-key',
    headers: {
      'x-openchatcut-provider': provider,
      origin,
      'sec-fetch-site': 'same-origin',
    },
  };
}

function providerFactory(
  provider: LlmProvider,
  origin: string,
): (modelId: string) => LanguageModelV4 {
  const options = proxyOptions(provider, origin);
  switch (provider) {
    case 'anthropic': return createAnthropic(options);
    case 'gemini': return createGoogleGenerativeAI(options);
    case 'kimi': return createMoonshotAI(options);
    case 'qwen': return createAlibaba(options);
    case 'deepseek': return createDeepSeek(options);
    case 'mistral': return createMistral(options);
    case 'xai': return createXai(options);
    default: return createOpenAICompatible({ name: provider, ...options });
  }
}

/**
 * The AI SDK runs a step's tools only when it finishes with `stop` or `tool-calls`.
 * OpenAI-compatible gateways that end a tool-calling turn with a non-standard
 * finish_reason, or none, surface as `other`: the calls would go unexecuted and the
 * next request would fail with MissingToolResultsError. Report those steps as
 * `tool-calls`; `length`, `content-filter` and `error` keep the SDK's refusal.
 */
function toolCallFinishReason(
  finishReason: LanguageModelV4FinishReason,
  calledTools: boolean,
): LanguageModelV4FinishReason {
  return calledTools && finishReason.unified === 'other'
    ? { ...finishReason, unified: 'tool-calls' }
    : finishReason;
}

export const toolCallFinishReasonMiddleware: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const calledTools = result.content.some((part) => (
      part.type === 'tool-call' && !part.providerExecuted
    ));
    return { ...result, finishReason: toolCallFinishReason(result.finishReason, calledTools) };
  },
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    let calledTools = false;
    return {
      ...rest,
      stream: stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === 'tool-call' && !part.providerExecuted) calledTools = true;
          controller.enqueue(part.type === 'finish'
            ? { ...part, finishReason: toolCallFinishReason(part.finishReason, calledTools) }
            : part);
        },
      })),
    };
  },
};

function baseServerLanguageModel(
  provider: LlmProvider,
  modelId: string,
  apiMode: OpenAiApiMode,
  origin: string,
): LanguageModelV4 {
  const policy = resolveModelRequestPolicy(provider, apiMode);
  if (policy.protocol === 'openai') {
    const openai = createOpenAI(proxyOptions(provider, origin));
    return policy.apiMode === 'chat' ? openai.chat(modelId) : openai.responses(modelId);
  }
  return providerFactory(provider, origin)(modelId);
}

/** Use the same local proxy and provider-specific SDKs as the browser Agent. */
export function createServerLanguageModel(
  provider: LlmProvider,
  modelId: string,
  apiMode: OpenAiApiMode,
  origin: string,
): LanguageModelV4 {
  return wrapLanguageModel({
    model: baseServerLanguageModel(provider, modelId, apiMode, origin),
    middleware: toolCallFinishReasonMiddleware,
  });
}

export function serverProviderOptions(
  provider: LlmProvider,
  apiMode: OpenAiApiMode,
  cacheMode: AgentCacheMode,
): SharedV4ProviderOptions | undefined {
  return resolveModelRequestPolicy(provider, apiMode, cacheMode).providerOptions;
}
