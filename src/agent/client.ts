import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';
import {
  DEFAULT_LLM_PROVIDER,
  defaultModelForProvider,
  normalizeLlmProvider,
  protocolForProvider,
  providerApiPath,
  type LlmProvider,
} from '../../shared/llm-providers';
import { normalizeLlmMessages } from './messages';

export {
  DEFAULT_LLM_PROVIDER,
  defaultModelForProvider,
  normalizeLlmProvider,
  providerApiPath,
};
export type { LlmProvider };
export type ConfiguredLanguageModel = Exclude<LanguageModel, string>;

export let PROVIDER: LlmProvider = DEFAULT_LLM_PROVIDER;
export let MODEL = defaultModelForProvider(PROVIDER);

export function setLlmConfig(provider: unknown, model: unknown): void {
  PROVIDER = normalizeLlmProvider(provider);
  MODEL = typeof model === 'string' && model.trim()
    ? model.trim()
    : defaultModelForProvider(PROVIDER);
}

export function setLlmModel(model: string): void {
  setLlmConfig(PROVIDER, model);
}

export function setLlmProvider(provider: unknown): void {
  setLlmConfig(provider, '');
}

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
// The server proxy target owns the provider/version prefix. AI SDK appends the
// native operation path, which also supports compatible APIs such as
// `/v1beta/openai/chat/completions`.
const PROXY_API_BASE = `${ORIGIN}/llm`;
const PROXY_KEY = 'proxy-injects-the-real-key';

const anthropicProvider = createAnthropic({
  baseURL: PROXY_API_BASE,
  apiKey: PROXY_KEY,
});
const openaiProvider = createOpenAI({
  baseURL: PROXY_API_BASE,
  apiKey: PROXY_KEY,
});
const compatibleProvider = createOpenAICompatible({
  name: 'openai-compatible',
  baseURL: PROXY_API_BASE,
  apiKey: PROXY_KEY,
});

export function getLanguageModel(
  provider: LlmProvider = PROVIDER,
  model: string = MODEL,
): ConfiguredLanguageModel {
  const protocol = protocolForProvider(provider);
  if (protocol === 'anthropic') return anthropicProvider(model);
  if (protocol === 'openai') return openaiProvider.responses(model);
  return compatibleProvider(model);
}

export async function generateAgentText(options: {
  system?: string;
  prompt: string;
  maxOutputTokens: number;
}): Promise<string> {
  const result = await generateText({
    model: getLanguageModel(),
    system: options.system,
    prompt: options.prompt,
    maxOutputTokens: options.maxOutputTokens,
  });
  return result.text;
}

// Compatibility wrapper for focused generation helpers that still use the
// Anthropic MessageCreateParams shape internally. Transport and model execution
// are handled by the provider-neutral Vercel AI SDK.
export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  const result = await generateText({
    model: getLanguageModel(PROVIDER, params.model),
    system: typeof params.system === 'string'
      ? params.system
      : params.system?.map((part) => part.text).join('\n'),
    messages: normalizeLlmMessages(params.messages),
    maxOutputTokens: params.max_tokens,
  });
  return {
    id: result.response.id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: result.text, citations: null }],
    model: params.model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
    },
    container: null,
  } as unknown as Anthropic.Message;
}
