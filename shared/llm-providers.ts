/** wire protocol the SERVER proxy speaks upstream: auth header + path family.
 * 'google' = Gemini native API (x-goog-api-key, /models/{id}:generateContent),
 *            routed client-side through the dedicated @ai-sdk/google provider. */
export type LlmProtocol = 'anthropic' | 'openai' | 'google' | 'openai-compatible';
export type OpenAiApiMode = 'responses' | 'chat';
/** ZCode / 9arghCompany-style wire format (what the user picks in Settings). */
export type ProviderApiFormat =
  | 'anthropic_messages'
  | 'chat_completions'
  | 'responses';
export const DEFAULT_OPENAI_API_MODE: OpenAiApiMode = 'responses';

export const API_FORMAT_OPTIONS: readonly {
  readonly value: ProviderApiFormat;
  readonly label: string;
}[] = [
  { value: 'anthropic_messages', label: 'Anthropic messages (/v1/messages)' },
  { value: 'chat_completions', label: 'Chat completions (/chat/completions)' },
  { value: 'responses', label: 'Responses (/responses)' },
] as const;

export interface LlmProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly protocol: LlmProtocol;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** User-created via Settings → persisted in .env.local */
  readonly custom?: boolean;
  /** Wire format; custom providers always set this. Built-ins derive from protocol. */
  readonly apiFormat?: ProviderApiFormat;
}

/** Custom provider definition (JSON in LLM_CUSTOM_PROVIDERS). */
export interface CustomLlmProviderDef {
  readonly id: string;
  readonly label: string;
  /** Preferred field (ZCode-style). */
  readonly apiFormat: ProviderApiFormat;
  /** Derived / legacy — kept for older .env.local rows. */
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
    // Native Google API: routed client-side via @ai-sdk/google (createGoogleGenerativeAI),
    // which owns the /models/{id}:generateContent path + x-goog-api-key auth. The server
    // proxy only injects the header + forwards to baseUrl.
    id: 'gemini',
    label: 'Google · Gemini',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
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
    id: 'xiaomi',
    label: 'Xiaomi · MiMo',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
  },
  {
    // 9Router: BYOK OpenAI-compatible aggregation gateway. Point BASE_URL at your own
    // instance and set the API key; all models advertised at GET /models become
    // selectable after the settings "Test & read models" probe (discoverableModel).
    id: '9router',
    label: '9Router',
    protocol: 'openai-compatible',
    baseUrl: 'http://43.133.32.109:20128/v1',
    defaultModel: 'ag/claude-sonnet-4-6',
  },
  // Frame / 9arghCompany / ZCode-style Maxplus gateways
  {
    id: 'maxplus-grok',
    label: 'Maxplus · Grok',
    protocol: 'anthropic',
    baseUrl: 'https://api.maxplus-ai.cc/v1',
    defaultModel: 'grok-4.5',
  },
  {
    id: 'maxplus-codex',
    label: 'Maxplus · Codex',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.maxplus-ai.cc/v1',
    defaultModel: 'gpt-5.4',
  },
] as const satisfies readonly LlmProviderPreset[];

/** Built-in ids (for type narrowing helpers). */
export type BuiltinLlmProvider = (typeof LLM_PROVIDER_PRESETS)[number]['id'];

/** Any agent LLM vendor id: built-in or custom-* */
export type LlmProvider = string;

export const DEFAULT_LLM_PROVIDER: LlmProvider = 'anthropic';

export interface LlmProviderConfigNames {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

const BUILTIN = new Map<string, LlmProviderPreset>(
  LLM_PROVIDER_PRESETS.map((preset) => [preset.id, preset]),
);

/** Runtime custom providers (from .env.local LLM_CUSTOM_PROVIDERS). */
let customProviders: CustomLlmProviderDef[] = [];

export function listCustomLlmProviders(): readonly CustomLlmProviderDef[] {
  return customProviders;
}

export function setCustomLlmProviders(list: readonly CustomLlmProviderDef[]): void {
  const seen = new Set<string>();
  customProviders = list
    .map(normalizeCustomDef)
    .filter((item): item is CustomLlmProviderDef => item !== null)
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true))); // dedup by id, keep first
}

export function parseCustomLlmProvidersJson(raw: unknown): CustomLlmProviderDef[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeCustomDef)
      .filter((item): item is CustomLlmProviderDef => item !== null);
  } catch {
    return [];
  }
}

export function serializeCustomLlmProviders(list: readonly CustomLlmProviderDef[]): string {
  return JSON.stringify(list.map(normalizeCustomDef).filter(Boolean));
}

function normalizeCustomDef(value: unknown): CustomLlmProviderDef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? slugifyProviderId(row.id) : '';
  const label = typeof row.label === 'string' ? row.label.trim() : '';
  const baseUrl = typeof row.baseUrl === 'string' ? row.baseUrl.trim().replace(/\/+$/, '') : '';
  const defaultModel = typeof row.defaultModel === 'string' ? row.defaultModel.trim() : '';
  if (!id || !label || !baseUrl) return null;
  // Never shadow built-ins
  if (BUILTIN.has(id)) return null;
  const apiFormat = normalizeApiFormat(
    row.apiFormat,
    typeof row.protocol === 'string' ? row.protocol : undefined,
  );
  return {
    id,
    label,
    apiFormat,
    protocol: apiFormatToProtocol(apiFormat),
    baseUrl,
    defaultModel: defaultModel || 'default',
  };
}

export function normalizeProtocol(value: unknown): LlmProtocol {
  if (value === 'openai' || value === 'openai-compatible' || value === 'anthropic' || value === 'google') {
    return value;
  }
  return 'openai-compatible';
}

export function normalizeApiFormat(
  value: unknown,
  legacyProtocol?: unknown,
): ProviderApiFormat {
  if (value === 'anthropic_messages' || value === 'chat_completions' || value === 'responses') {
    return value;
  }
  // 9arghCompany aliases
  if (value === 'anthropic') return 'anthropic_messages';
  if (value === 'chat' || value === 'openai-compatible') return 'chat_completions';
  if (value === 'openai') return 'responses';
  // Legacy protocol field only
  const p = normalizeProtocol(legacyProtocol);
  if (p === 'anthropic') return 'anthropic_messages';
  if (p === 'openai') return 'responses';
  return 'chat_completions';
}

export function apiFormatToProtocol(format: ProviderApiFormat): LlmProtocol {
  if (format === 'anthropic_messages') return 'anthropic';
  if (format === 'responses') return 'openai';
  return 'openai-compatible';
}

export function apiFormatToOpenAiMode(format: ProviderApiFormat): OpenAiApiMode {
  return format === 'responses' ? 'responses' : 'chat';
}

export function protocolToApiFormat(
  protocol: LlmProtocol,
  openAiMode: OpenAiApiMode = DEFAULT_OPENAI_API_MODE,
): ProviderApiFormat {
  if (protocol === 'anthropic') return 'anthropic_messages';
  if (protocol === 'openai') {
    return openAiMode === 'chat' ? 'chat_completions' : 'responses';
  }
  // 'google' has no user-selectable wire format (the @ai-sdk/google client owns the
  // native /models/{id}:generateContent path). Return a benign default; providerApiPath
  // short-circuits google before reaching here, so this only guards direct callers.
  if (protocol === 'google') return 'chat_completions';
  return 'chat_completions';
}

/** Safe slug for provider id / env token base. */
export function slugifyProviderId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!cleaned) return '';
  // Prefer custom- prefix for user-added vendors
  if (BUILTIN.has(cleaned)) return `custom-${cleaned}`;
  if (!cleaned.startsWith('custom-') && !BUILTIN.has(cleaned)) {
    // Allow maxplus-* style and custom-*
    if (/^[a-z][a-z0-9-]*$/.test(cleaned)) return cleaned;
  }
  return cleaned;
}

export function customDefToPreset(def: CustomLlmProviderDef): LlmProviderPreset {
  const apiFormat = normalizeApiFormat(def.apiFormat, def.protocol);
  return {
    id: def.id,
    label: def.label,
    protocol: apiFormatToProtocol(apiFormat),
    baseUrl: def.baseUrl,
    defaultModel: def.defaultModel,
    custom: true,
    apiFormat,
  };
}

/** Effective wire format for any provider (custom or built-in). */
export function apiFormatForProvider(
  provider: unknown,
  openAiMode: OpenAiApiMode = DEFAULT_OPENAI_API_MODE,
): ProviderApiFormat {
  const preset = llmProviderPreset(provider);
  if (preset.apiFormat) return preset.apiFormat;
  return protocolToApiFormat(preset.protocol, openAiMode);
}

/** OpenAI SDK mode when talking to this provider (responses vs chat). */
export function openAiModeForProvider(
  provider: unknown,
  fallback: OpenAiApiMode = DEFAULT_OPENAI_API_MODE,
): OpenAiApiMode {
  const preset = llmProviderPreset(provider);
  if (preset.apiFormat) return apiFormatToOpenAiMode(preset.apiFormat);
  if (preset.protocol === 'openai') return fallback;
  return 'chat';
}

/** Built-in + custom (for settings list, model picker, probes). */
export function allLlmProviderPresets(): LlmProviderPreset[] {
  return [
    ...LLM_PROVIDER_PRESETS,
    ...customProviders.map(customDefToPreset),
  ];
}

export function isKnownLlmProvider(value: unknown): boolean {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!id) return false;
  return BUILTIN.has(id) || customProviders.some((p) => p.id === id);
}

export function normalizeLlmProvider(value: unknown): LlmProvider {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isKnownLlmProvider(normalized)) return normalized;
  return DEFAULT_LLM_PROVIDER;
}

export function llmProviderPreset(provider: unknown): LlmProviderPreset {
  const id = normalizeLlmProvider(provider);
  return (
    allLlmProviderPresets().find((preset) => preset.id === id)
    ?? LLM_PROVIDER_PRESETS[0]
  );
}

/** Stable per-vendor setting names. Secrets stay server-side; URL/model are non-secret config. */
export function llmProviderConfigNames(provider: unknown): LlmProviderConfigNames {
  const token = normalizeLlmProvider(provider).replace(/-/g, '_').toUpperCase();
  return {
    apiKey: `LLM_${token}_API_KEY`,
    baseUrl: `LLM_${token}_BASE_URL`,
    model: `LLM_${token}_MODEL`,
  };
}

export function defaultModelForProvider(provider: unknown): string {
  return llmProviderPreset(provider).defaultModel;
}

export function protocolForProvider(provider: unknown): LlmProtocol {
  const preset = llmProviderPreset(provider);
  if (preset.apiFormat) return apiFormatToProtocol(preset.apiFormat);
  return preset.protocol;
}

export function normalizeOpenAiApiMode(value: unknown): OpenAiApiMode {
  return value === 'chat' ? 'chat' : DEFAULT_OPENAI_API_MODE;
}

export function providerApiPath(
  provider: unknown,
  openAiApiMode: unknown = DEFAULT_OPENAI_API_MODE,
): string {
  // Native Google API: the @ai-sdk/google client owns /models/{id}:generateContent.
  // The probe lists catalog at GET /models.
  if (protocolForProvider(provider) === 'google') return '/models';
  const format = apiFormatForProvider(provider, normalizeOpenAiApiMode(openAiApiMode));
  if (format === 'anthropic_messages') return '/messages';
  if (format === 'responses') return '/responses';
  return '/chat/completions';
}

/** Env key that stores JSON catalog of custom providers (non-secret). */
export const LLM_CUSTOM_PROVIDERS_KEY = 'LLM_CUSTOM_PROVIDERS';

/** True for LLM_*_API_KEY / BASE_URL / MODEL dynamic keys. */
export function isDynamicLlmEnvKey(name: string): boolean {
  return /^LLM_[A-Z][A-Z0-9_]*_(API_KEY|BASE_URL|MODEL)$/.test(name);
}

export function isNonSecretLlmEnvKey(name: string): boolean {
  if (name === LLM_CUSTOM_PROVIDERS_KEY || name === 'LLM_PROVIDER' || name === 'LLM_MODEL' || name === 'LLM_OPENAI_API_MODE') {
    return true;
  }
  return /^LLM_[A-Z][A-Z0-9_]*_(BASE_URL|MODEL)$/.test(name);
}
