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
  protocolForProvider,
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

const proxyHeaders = (provider: LlmProvider): Record<string, string> => ({
  'x-openchatcut-provider': provider,
});

const anthropicProvider = createAnthropic({
  baseURL: PROXY_API_BASE,
  apiKey: PROXY_KEY,
  headers: proxyHeaders('anthropic'),
});
const openaiProvider = createOpenAI({
  baseURL: PROXY_API_BASE,
  apiKey: PROXY_KEY,
  headers: proxyHeaders('openai'),
});
const compatibleProviders = new Map<LlmProvider, ReturnType<typeof createOpenAICompatible>>();

function compatibleProvider(provider: LlmProvider): ReturnType<typeof createOpenAICompatible> {
  const existing = compatibleProviders.get(provider);
  if (existing) return existing;
  const created = createOpenAICompatible({
    name: provider,
    baseURL: PROXY_API_BASE,
    apiKey: PROXY_KEY,
    headers: proxyHeaders(provider),
  });
  compatibleProviders.set(provider, created);
  return created;
}

export function getLanguageModel(
  provider: LlmProvider = PROVIDER,
  model: string = MODEL,
): ConfiguredLanguageModel {
  const protocol = protocolForProvider(provider);
  if (protocol === 'anthropic') return anthropicProvider(model);
  if (protocol === 'openai') return openaiProvider.responses(model);
  return compatibleProvider(provider)(model);
}

export function getLanguageModelProviderOptions(
  provider: LlmProvider = PROVIDER,
) {
  return protocolForProvider(provider) === 'openai'
    ? { openai: { store: false } }
    : undefined;
}

export async function generateAgentText(options: {
  system?: string;
  prompt?: string;
  messages?: readonly unknown[];
  maxOutputTokens: number;
}): Promise<string> {
  const base = {
    model: getLanguageModel(),
    system: options.system,
    maxOutputTokens: options.maxOutputTokens,
  };
  const result = options.messages
    ? await generateText({
        ...base,
        messages: normalizeLlmMessages(options.messages),
      })
    : await generateText({
        ...base,
        prompt: options.prompt ?? '',
      });
  return result.text;
}
