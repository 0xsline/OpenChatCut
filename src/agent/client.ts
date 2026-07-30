import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  MODEL,
  OPENAI_API_MODE,
  PROVIDER,
  protocolForProvider,
} from './providerConfig';
import type { LlmProvider, OpenAiApiMode } from './providerConfig';
import { normalizeLlmMessages } from './messages';

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
let openAiProviderPromise: Promise<OpenAiProvider> | null = null;

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

function openAiProvider(): Promise<OpenAiProvider> {
  if (openAiProviderPromise) return openAiProviderPromise;
  openAiProviderPromise = import('@ai-sdk/openai')
    .then(({ createOpenAI }) => createOpenAI(providerOptions('openai')))
    .catch((error: unknown) => {
      openAiProviderPromise = null;
      throw error;
    });
  return openAiProviderPromise;
}

export async function getLanguageModel(
  provider: LlmProvider = PROVIDER,
  model: string = MODEL,
  openAiApiMode: OpenAiApiMode = OPENAI_API_MODE,
): Promise<ConfiguredLanguageModel> {
  if (protocolForProvider(provider) === 'openai') {
    const openai = await openAiProvider();
    return openAiApiMode === 'chat' ? openai.chat(model) : openai.responses(model);
  }
  return (await providerFactory(provider))(model);
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
    model: await getLanguageModel(),
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
