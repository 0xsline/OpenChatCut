/** wire protocol the SERVER proxy speaks upstream: auth header + path family.
 * 'google' = Gemini native API (x-goog-api-key, /models/{id}:generateContent). */
export type LlmProtocol = 'anthropic' | 'openai' | 'google' | 'openai-compatible';
export type OpenAiApiMode = 'responses' | 'chat';
export const DEFAULT_OPENAI_API_MODE: OpenAiApiMode = 'responses';
const MIN_CONTEXT_WINDOW_TOKENS = 4_096;
const MAX_CONTEXT_WINDOW_TOKENS = 4_000_000;

interface LlmProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly protocol: LlmProtocol;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly contextWindowTokens: number;
  readonly contextWindowEstimated?: boolean;
}

export const LLM_PROVIDER_PRESETS = [
  {
    id: 'anthropic',
    label: 'Anthropic · Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-fable-5',
    contextWindowTokens: 200_000,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
    contextWindowTokens: 400_000,
  },
  {
    id: 'gemini',
    label: 'Google · Gemini',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.5-flash',
    contextWindowTokens: 1_048_576,
  },
  {
    id: 'kimi',
    label: 'Moonshot AI · Kimi',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    contextWindowTokens: 262_144,
  },
  {
    id: 'qwen',
    label: 'Alibaba Cloud · Qwen',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    contextWindowTokens: 131_072,
  },
  {
    id: 'glm',
    label: 'Zhipu AI · GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.2',
    contextWindowTokens: 131_072,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    contextWindowTokens: 131_072,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M3',
    contextWindowTokens: 204_800,
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi · MiMo',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    contextWindowTokens: 131_072,
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    contextWindowTokens: 131_072,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    contextWindowTokens: 131_072,
    contextWindowEstimated: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    contextWindowTokens: 32_768,
    contextWindowEstimated: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (Local)',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'qwen2.5-coder-7b-instruct',
    contextWindowTokens: 32_768,
    contextWindowEstimated: true,
  },
] as const satisfies readonly LlmProviderPreset[];

export type LlmProvider = (typeof LLM_PROVIDER_PRESETS)[number]['id'];

export const DEFAULT_LLM_PROVIDER: LlmProvider = 'anthropic';

export interface LlmProviderConfigNames {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly contextWindow: string;
}

const PRESETS = new Map<string, (typeof LLM_PROVIDER_PRESETS)[number]>(
  LLM_PROVIDER_PRESETS.map((preset) => [preset.id, preset] as const),
);

export function normalizeLlmProvider(value: unknown): LlmProvider {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PRESETS.has(normalized) ? normalized as LlmProvider : DEFAULT_LLM_PROVIDER;
}

export function isLocalLlmProvider(provider: unknown): boolean {
  const normalized = normalizeLlmProvider(provider);
  return normalized === 'ollama' || normalized === 'lmstudio';
}

export function llmProviderPreset(provider: unknown): LlmProviderPreset {
  return PRESETS.get(normalizeLlmProvider(provider)) ?? LLM_PROVIDER_PRESETS[0];
}

/** Stable per-vendor setting names. Secrets stay server-side; URL/model are non-secret config. */
export function llmProviderConfigNames(provider: unknown): LlmProviderConfigNames {
  const token = normalizeLlmProvider(provider).replace(/-/g, '_').toUpperCase();
  return {
    apiKey: `LLM_${token}_API_KEY`,
    baseUrl: `LLM_${token}_BASE_URL`,
    model: `LLM_${token}_MODEL`,
    contextWindow: `LLM_${token}_CONTEXT_WINDOW`,
  };
}

export function defaultModelForProvider(provider: unknown): string {
  return llmProviderPreset(provider).defaultModel;
}

export function defaultContextWindowForProvider(provider: unknown): number {
  return llmProviderPreset(provider).contextWindowTokens;
}

export interface ModelContextWindow {
  readonly tokens: number;
  readonly estimated: boolean;
}

export function contextWindowForModel(
  provider: unknown,
  model: string,
  configured: unknown,
): ModelContextWindow {
  const override = typeof configured === 'string' ? Number(configured.trim()) : Number.NaN;
  if (Number.isSafeInteger(override)
    && override >= MIN_CONTEXT_WINDOW_TOKENS
    && override <= MAX_CONTEXT_WINDOW_TOKENS) {
    return { tokens: override, estimated: false };
  }
  const preset = llmProviderPreset(provider);
  const normalizedModel = model.trim();
  return {
    tokens: preset.contextWindowTokens,
    estimated: preset.contextWindowEstimated === true
      || (normalizedModel.length > 0 && normalizedModel !== preset.defaultModel),
  };
}

export function protocolForProvider(provider: unknown): LlmProtocol {
  return llmProviderPreset(provider).protocol;
}

export function normalizeOpenAiApiMode(value: unknown): OpenAiApiMode {
  return value === 'chat' ? 'chat' : DEFAULT_OPENAI_API_MODE;
}

export function providerApiPath(
  provider: unknown,
  openAiApiMode: unknown = DEFAULT_OPENAI_API_MODE,
): string {
  const protocol = protocolForProvider(provider);
  if (protocol === 'anthropic') return '/messages';
  if (protocol === 'google') return '/models'; // Native API path according to model:/models/{id}:generateContent
  if (protocol === 'openai') {
    return normalizeOpenAiApiMode(openAiApiMode) === 'chat'
      ? '/chat/completions'
      : '/responses';
  }
  return '/chat/completions';
}
