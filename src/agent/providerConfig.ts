// Compatibility export for older imports. LLM state lives only in client.ts.
export {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OPENAI_API_MODE,
  defaultModelForProvider,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  protocolForProvider,
  providerApiPath,
  PROVIDER,
  MODEL,
  OPENAI_API_MODE,
  setLlmConfig,
  setLlmModel,
  setLlmProvider,
} from './client';
export type { LlmProvider, OpenAiApiMode } from './client';
