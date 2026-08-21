import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  MODEL,
  OPENAI_API_MODE,
  PROVIDER,
  protocolForProvider,
} from './providerConfig';
import type { LlmProvider, OpenAiApiMode } from './providerConfig';
import { normalizeLlmMessages, withoutModelImages } from './messages';
import { getActiveAgentModelChoice, getAgentModelSnapshot, type AgentModelChoice } from './model-selection';
import { effectiveOutputTokenBudget } from './context-compaction';
import type { AgentCacheMode } from './settings/agentSettings';

export {
  MODEL,
  OPENAI_API_MODE,
  PROVIDER,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OPENAI_API_MODE,
  defaultModelForProvider,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  protocolForProvider,
  providerApiPath,
  setLlmConfig,
  setLlmModel,
  setLlmProvider,
} from './providerConfig';
export type { LlmProvider, OpenAiApiMode } from './providerConfig';
export type ConfiguredLanguageModel = Exclude<LanguageModel, string>;

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
// The server proxy target owns the provider/version prefix. AI SDK appends the
// native operation path, which also supports compatible APIs such as
// `/v1beta/openai/chat/completions`.
const PROXY_API_BASE = `${ORIGIN}/llm`;
const PROXY_KEY = 'proxy-injects-the-real-key';


interface ProviderOptions {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
}

type ModelFactory = (model: string) => ConfiguredLanguageModel;
type OpenAiProvider = {
  chat: ModelFactory;
  responses: ModelFactory;
};

const factoryPromises = new Map<LlmProvider, Promise<ModelFactory>>();
const openAiProviderPromises = new Map<LlmProvider, Promise<OpenAiProvider>>();

function providerOptions(provider: LlmProvider): ProviderOptions {
  return {
    baseURL: PROXY_API_BASE,
    apiKey: PROXY_KEY,
    headers: { 'x-openchatcut-provider': provider },
  };
}

// The configured provider is runtime-selected. Every branch is a literal so
// Vite discovers all allowed chunks without evaluating unselected SDKs.
async function createProviderFactory(provider: LlmProvider): Promise<ModelFactory> {
  const options = providerOptions(provider);
  switch (provider) {
    case 'anthropic':
      return (await import('@ai-sdk/anthropic')).createAnthropic(options);
    case 'gemini':
      return (await import('@ai-sdk/google')).createGoogleGenerativeAI(options);
    case 'kimi':
      return (await import('@ai-sdk/moonshotai')).createMoonshotAI(options);
    case 'qwen':
      return (await import('@ai-sdk/alibaba')).createAlibaba(options);
    case 'deepseek':
      return (await import('@ai-sdk/deepseek')).createDeepSeek(options);
    case 'mistral':
      return (await import('@ai-sdk/mistral')).createMistral(options);
    default: {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      return createOpenAICompatible({ name: provider, ...options });
    }
  }
}

function providerFactory(provider: LlmProvider): Promise<ModelFactory> {
  const existing = factoryPromises.get(provider);
  if (existing) return existing;
  const created = createProviderFactory(provider);
  factoryPromises.set(provider, created);
  created.catch(() => factoryPromises.delete(provider));
  return created;
}

function openAiProvider(provider: LlmProvider): Promise<OpenAiProvider> {
  const existing = openAiProviderPromises.get(provider);
  if (existing) return existing;
  const created = import('@ai-sdk/openai')
    .then(({ createOpenAI }) => createOpenAI(providerOptions(provider)))
    .catch((error: unknown) => {
      openAiProviderPromises.delete(provider);
      throw error;
    });
  openAiProviderPromises.set(provider, created);
  return created;
}
export async function getLanguageModel(
  provider: LlmProvider = PROVIDER,
  model: string = MODEL,
  openAiApiMode: OpenAiApiMode = OPENAI_API_MODE,
): Promise<ConfiguredLanguageModel> {
  if (protocolForProvider(provider) === 'openai') {
    const openai = await openAiProvider(provider);
    // The xAI subscription session speaks the Responses API only; the global
    // OpenAI chat/responses toggle must not switch it to chat completions.
    const mode = provider === 'xai-oauth' ? 'responses' : openAiApiMode;
    return mode === 'chat' ? openai.chat(model) : openai.responses(model);
  }
  return (await providerFactory(provider))(model);
}

export function getLanguageModelProviderOptions(
  provider: LlmProvider = PROVIDER,
  openAiApiMode: OpenAiApiMode = OPENAI_API_MODE,
  cacheMode: AgentCacheMode = 'short',
): Record<string, Record<string, boolean>> | undefined {
  if (provider === 'anthropic') {
    const cacheControl = cacheMode === 'long'
      ? { type: 'ephemeral', ttl: '1h' }
      : { type: 'ephemeral' };
    return { anthropic: { cacheControl } as unknown as Record<string, boolean> };
  }
  if (provider === 'minimax') {
    return { minimax: { reasoning_split: true } };
  }
  if (provider === 'xai-oauth') return undefined;
  return protocolForProvider(provider) === 'openai' && openAiApiMode === 'responses'
    ? { openai: { store: false } }
    : undefined;
}
export function cacheTtlMsForProvider(
  provider: LlmProvider,
  cacheMode: AgentCacheMode,
): number | undefined {
  if (provider !== 'anthropic') return undefined;
  return cacheMode === 'long' ? 60 * 60 * 1000 : 5 * 60 * 1000;
}


function generationChoice(): AgentModelChoice | undefined {
  const active = getActiveAgentModelChoice();
  if (active?.backend === 'api') return active;
  return getAgentModelSnapshot().choices.find((choice) => (
    choice.backend === 'api' && choice.provider === PROVIDER && choice.model === MODEL
  ));
}

export async function generateAgentText(options: {
  system?: string;
  prompt?: string;
  messages?: readonly unknown[];
  maxOutputTokens: number;
}): Promise<string> {
  const choice = generationChoice();
  const provider = choice?.provider ?? PROVIDER;
  const model = choice?.model ?? MODEL;
  const apiMode = choice?.openAiApiMode ?? OPENAI_API_MODE;
  const providerOptions = getLanguageModelProviderOptions(provider, apiMode);
  const modelOutputLimit = choice
    ? effectiveOutputTokenBudget(
        choice.capabilities.maxOutputTokens.value,
        choice.capabilities.contextWindowTokens.value,
      )
    : options.maxOutputTokens;
  const maxOutputTokens = Math.min(options.maxOutputTokens, modelOutputLimit);
  const base = {
    model: await getLanguageModel(provider, model, apiMode),
    system: options.system,
    maxOutputTokens,
    timeout: { totalMs: 60_000 },
    ...(providerOptions ? { providerOptions } : {}),
  };
  const normalized = options.messages ? normalizeLlmMessages(options.messages) : null;
  const messages = normalized && choice?.capabilities.supportsImages.value === false
    ? withoutModelImages(normalized)
    : normalized;
  const result = messages
    ? await generateText({ ...base, messages })
    : await generateText({ ...base, prompt: options.prompt ?? '' });
  return result.text;
}
