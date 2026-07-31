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
