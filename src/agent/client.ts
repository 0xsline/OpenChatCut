import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createAlibaba } from '@ai-sdk/alibaba';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';
import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OPENAI_API_MODE,
  defaultModelForProvider,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  protocolForProvider,
  providerApiPath,
  type LlmProvider,
  type OpenAiApiMode,
} from '../../shared/llm-providers';
import { normalizeLlmMessages } from './messages';

export {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OPENAI_API_MODE,
  defaultModelForProvider,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  protocolForProvider,
  providerApiPath,
};
export type { LlmProvider, OpenAiApiMode };
export type ConfiguredLanguageModel = Exclude<LanguageModel, string>;

export let PROVIDER: LlmProvider = DEFAULT_LLM_PROVIDER;
export let MODEL = defaultModelForProvider(PROVIDER);
export let OPENAI_API_MODE: OpenAiApiMode = DEFAULT_OPENAI_API_MODE;

export function setLlmConfig(
  provider: unknown,
  model: unknown,
  openAiApiMode: unknown = OPENAI_API_MODE,
): void {
  PROVIDER = normalizeLlmProvider(provider);
  MODEL = typeof model === 'string' && model.trim()
    ? model.trim()
    : defaultModelForProvider(PROVIDER);
  OPENAI_API_MODE = normalizeOpenAiApiMode(openAiApiMode);
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

// Anthropic-protocol providers are cached PER PROVIDER ID (not a single singleton):
// maxplus-grok and other Anthropic-speaking gateways carry their own config
// (LLM_MAXPLUS_GROK_*), routed server-side via the x-openchatcut-provider header.
// A shared singleton would hard-code that header to 'anthropic' and misroute every
// anthropic-protocol preset to api.anthropic.com.
const anthropicProviders = new Map<LlmProvider, ReturnType<typeof createAnthropic>>();
function anthropicProviderFor(provider: LlmProvider): ReturnType<typeof createAnthropic> {
  let p = anthropicProviders.get(provider);
  if (!p) {
    p = createAnthropic({ baseURL: PROXY_API_BASE, apiKey: PROXY_KEY, headers: proxyHeaders(provider) });
    anthropicProviders.set(provider, p);
  }
  return p;
}
// OpenAI-protocol providers are ALSO cached PER PROVIDER ID (same reason as anthropic
// above): a custom provider with apiFormat 'responses' (→ protocol 'openai') must carry
// its OWN x-openchatcut-provider header so the server routes to LLM_<ID>_BASE_URL, not
// api.openai.com. A singleton would hard-code the header to 'openai' and misroute every
// openai-protocol custom provider. The built-in 'openai' id still works (its cache entry
// just has header 'openai').
const openaiProviders = new Map<LlmProvider, ReturnType<typeof createOpenAI>>();
function openaiProviderFor(provider: LlmProvider): ReturnType<typeof createOpenAI> {
  let p = openaiProviders.get(provider);
  if (!p) {
    p = createOpenAI({ baseURL: PROXY_API_BASE, apiKey: PROXY_KEY, headers: proxyHeaders(provider) });
    openaiProviders.set(provider, p);
  }
  return p;
}
// 有官方专属包的厂商一律用官方包(厂商特有语义 — 如 Gemini thought_signature —
// 由官方 provider 处理);其余走 openai-compatible。都经 /llm 代理注入真实密钥。
const proxied = <T>(provider: LlmProvider, create: (o: { baseURL: string; apiKey: string; headers: Record<string, string> }) => T): T =>
  create({ baseURL: PROXY_API_BASE, apiKey: PROXY_KEY, headers: proxyHeaders(provider) });
const DEDICATED_PROVIDERS: Partial<Record<LlmProvider, (model: string) => ConfiguredLanguageModel>> = {
  gemini: proxied('gemini', createGoogleGenerativeAI),
  kimi: proxied('kimi', createMoonshotAI),
  qwen: proxied('qwen', createAlibaba),
  deepseek: proxied('deepseek', createDeepSeek),
  mistral: proxied('mistral', createMistral),
};

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
  openAiApiMode: OpenAiApiMode = OPENAI_API_MODE,
): ConfiguredLanguageModel {
  const protocol = protocolForProvider(provider);
  if (protocol === 'anthropic') return anthropicProviderFor(provider)(model);
  if (protocol === 'openai') {
    return openAiApiMode === 'chat'
      ? openaiProviderFor(provider).chat(model)
      : openaiProviderFor(provider).responses(model);
  }
  const dedicated = DEDICATED_PROVIDERS[provider];
  if (dedicated) return dedicated(model);
  return compatibleProvider(provider)(model);
}

export function getLanguageModelProviderOptions(
  provider: LlmProvider = PROVIDER,
  openAiApiMode: OpenAiApiMode = OPENAI_API_MODE,
): Record<string, Record<string, boolean>> | undefined {
  if (provider === 'minimax') {
    return { minimax: { reasoning_split: true } };
  }
  return protocolForProvider(provider) === 'openai' && openAiApiMode === 'responses'
    ? { openai: { store: false } }
    : undefined;
}

export async function generateAgentText(options: {
  system?: string;
  prompt?: string;
  messages?: readonly unknown[];
  maxOutputTokens: number;
}): Promise<string> {
  const providerOptions = getLanguageModelProviderOptions();
  const base = {
    model: getLanguageModel(),
    system: options.system,
    maxOutputTokens: options.maxOutputTokens,
    ...(providerOptions ? { providerOptions } : {}),
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
