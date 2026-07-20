export type LlmProtocol = 'anthropic' | 'openai' | 'openai-compatible';

interface LlmProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly protocol: LlmProtocol;
  readonly baseUrl: string;
  readonly defaultModel: string;
}

export const LLM_PROVIDER_PRESETS = [
  {
    id: 'anthropic',
    label: 'Anthropic · Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-fable-5',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
  },
  {
    id: 'gemini',
    label: 'Google · Gemini',
    protocol: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.5-flash',
  },
  {
    id: 'kimi',
    label: 'Moonshot AI · Kimi',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
  },
  {
    id: 'qwen',
    label: 'Alibaba Cloud · Qwen',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  {
    id: 'glm',
    label: 'Zhipu AI · GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.2',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M3',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
  },
  {
    id: 'openai-compatible',
    label: 'Custom OpenAI-compatible API',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
] as const satisfies readonly LlmProviderPreset[];

export type LlmProvider = (typeof LLM_PROVIDER_PRESETS)[number]['id'];

export const DEFAULT_LLM_PROVIDER: LlmProvider = 'anthropic';

const PRESETS = new Map<string, (typeof LLM_PROVIDER_PRESETS)[number]>(
  LLM_PROVIDER_PRESETS.map((preset) => [preset.id, preset] as const),
);

export function normalizeLlmProvider(value: unknown): LlmProvider {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PRESETS.has(normalized) ? normalized as LlmProvider : DEFAULT_LLM_PROVIDER;
}

export function llmProviderPreset(provider: unknown): (typeof LLM_PROVIDER_PRESETS)[number] {
  return PRESETS.get(normalizeLlmProvider(provider)) ?? LLM_PROVIDER_PRESETS[0];
}

export function defaultModelForProvider(provider: unknown): string {
  return llmProviderPreset(provider).defaultModel;
}

export function protocolForProvider(provider: unknown): LlmProtocol {
  return llmProviderPreset(provider).protocol;
}

export function providerApiPath(provider: unknown): string {
  const protocol = protocolForProvider(provider);
  if (protocol === 'anthropic') return '/messages';
  return protocol === 'openai' ? '/responses' : '/chat/completions';
}
