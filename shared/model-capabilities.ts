import modelsDevCatalog from '../assets/model-capabilities/models-dev.json' with { type: 'json' };
import { LLM_PROVIDER_PRESETS, type LlmProvider } from './llm-providers.js';

export const MODEL_CAPABILITY_OVERRIDES_KEY = 'AGENT_MODEL_CAPABILITY_OVERRIDES';
export type ModelBackend = 'api' | 'codex';
export type ModelCapabilitySource = 'catalog' | 'provider-fallback' | 'settings-override';

export interface ModelIdentity {
  readonly backend: ModelBackend;
  readonly provider: LlmProvider;
  readonly modelId: string;
}

export interface ModelCapability<T> {
  readonly value: T;
  readonly estimated: boolean;
  readonly source: ModelCapabilitySource;
}

export interface ModelCapabilities {
  readonly contextWindowTokens: ModelCapability<number>;
  readonly maxInputTokens: ModelCapability<number>;
  readonly maxOutputTokens: ModelCapability<number>;
  readonly supportsTools: ModelCapability<boolean>;
  readonly supportsImages: ModelCapability<boolean>;
  readonly supportsReasoning: ModelCapability<boolean>;
  readonly reasoningEfforts: ModelCapability<readonly string[]>;
  readonly defaultReasoningEffort?: ModelCapability<string>;
}

export interface ModelCapabilityOverride extends ModelIdentity {
  readonly contextWindowTokens?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly supportsTools?: boolean;
  readonly supportsImages?: boolean;
  readonly supportsReasoning?: boolean;
  readonly reasoningEfforts?: readonly string[];
  readonly defaultReasoningEffort?: string;
}

interface CatalogModel {
  readonly contextWindowTokens: number | null;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly input: readonly string[];
  readonly supportsTools: boolean | null;
  readonly reasoning: boolean | null;
  readonly reasoningEfforts: readonly string[];
}

const MAX_OVERRIDE_RECORDS = 256;
const MAX_OVERRIDE_BYTES = 65_536;
const MIN_CONTEXT_TOKENS = 4_096;
const MAX_CAPABILITY_TOKENS = 4_000_000;
const EFFORT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CAPABILITY_FIELDS = [
  'contextWindowTokens', 'maxInputTokens', 'maxOutputTokens', 'supportsTools',
  'supportsImages', 'supportsReasoning', 'reasoningEfforts', 'defaultReasoningEffort',
] as const;
const ALLOWED_FIELDS = new Set(['backend', 'provider', 'modelId', ...CAPABILITY_FIELDS]);
const PROVIDERS = new Set<string>(LLM_PROVIDER_PRESETS.map((preset) => preset.id));
const UNKNOWN_CONTEXT_TOKENS = 8_192;
const UNKNOWN_OUTPUT_TOKENS = 2_048;
const catalogProviders = modelsDevCatalog.providers as unknown as Partial<
  Record<LlmProvider, Readonly<Record<string, CatalogModel>>>
>;

type OverridePatch = Partial<Omit<ModelCapabilityOverride, keyof ModelIdentity>>;

function exact<T>(value: T, source: ModelCapabilitySource): ModelCapability<T> {
  return { value, estimated: false, source };
}

function fallback<T>(value: T): ModelCapability<T> {
  return { value, estimated: true, source: 'provider-fallback' };
}

function positiveInteger(value: unknown, min = 1): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= MAX_CAPABILITY_TOKENS
    ? Number(value)
    : undefined;
}

function parseIdentity(value: Record<string, unknown>): ModelIdentity {
  const backend = value.backend;
  const provider = value.provider;
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (backend !== 'api' && backend !== 'codex') throw new Error('Invalid model capability backend.');
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) throw new Error('Invalid model capability provider.');
  if (backend === 'codex' && provider !== 'openai') throw new Error('Codex capabilities require the OpenAI provider.');
  if (!modelId || modelId.length > 256 || [...modelId].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) {
    throw new Error('Invalid model capability model ID.');
  }
  return { backend, provider: provider as LlmProvider, modelId };
}

function parseEfforts(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid model reasoning efforts.');
  const efforts = value.map((effort) => {
    if (typeof effort !== 'string' || !EFFORT_PATTERN.test(effort)) throw new Error('Invalid model reasoning effort.');
    return effort;
  });
  if (new Set(efforts).size !== efforts.length) throw new Error('Duplicate model reasoning effort.');
  return efforts;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Invalid ${name} capability.`);
  return value;
}

function parseOverride(value: unknown): ModelCapabilityOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model capability record.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED_FIELDS.has(key))) throw new Error('Unknown model capability field.');
  const identity = parseIdentity(record);
  const context = record.contextWindowTokens === undefined ? undefined : positiveInteger(record.contextWindowTokens, MIN_CONTEXT_TOKENS);
  const input = record.maxInputTokens === undefined ? undefined : positiveInteger(record.maxInputTokens);
  const output = record.maxOutputTokens === undefined ? undefined : positiveInteger(record.maxOutputTokens);
  if (record.contextWindowTokens !== undefined && context === undefined) throw new Error('Invalid model context window.');
  if (record.maxInputTokens !== undefined && input === undefined) throw new Error('Invalid model input limit.');
  if (record.maxOutputTokens !== undefined && output === undefined) throw new Error('Invalid model output limit.');
  if (context !== undefined && input !== undefined && input > context) throw new Error('Model input limit exceeds its context window.');
  if (context !== undefined && output !== undefined && output > context) throw new Error('Model output limit exceeds its context window.');
  const supportsTools = optionalBoolean(record.supportsTools, 'supportsTools');
  const supportsImages = optionalBoolean(record.supportsImages, 'supportsImages');
  const supportsReasoning = optionalBoolean(record.supportsReasoning, 'supportsReasoning');
  const efforts = parseEfforts(record.reasoningEfforts);
  const defaultEffort = record.defaultReasoningEffort;
  if (defaultEffort !== undefined && (typeof defaultEffort !== 'string' || !EFFORT_PATTERN.test(defaultEffort))) {
    throw new Error('Invalid default reasoning effort.');
  }
  if (supportsReasoning === false && (efforts?.length || defaultEffort)) throw new Error('Disabled reasoning cannot declare efforts.');
  if (defaultEffort && (!efforts || !efforts.includes(defaultEffort))) throw new Error('Default reasoning effort is not supported.');
  const override: ModelCapabilityOverride = {
    ...identity,
    ...(context ? { contextWindowTokens: context } : {}),
    ...(input ? { maxInputTokens: input } : {}),
    ...(output ? { maxOutputTokens: output } : {}),
    ...(supportsTools !== undefined ? { supportsTools } : {}),
    ...(supportsImages !== undefined ? { supportsImages } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(efforts ? { reasoningEfforts: efforts } : {}),
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
  };
  if (!CAPABILITY_FIELDS.some((key) => key in override)) throw new Error('Empty model capability override.');
  return override;
}

function identityKey(identity: ModelIdentity): string {
  return JSON.stringify([identity.backend, identity.provider, identity.modelId]);
}

export function parseModelCapabilityOverrides(raw: unknown): readonly ModelCapabilityOverride[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_OVERRIDE_BYTES) throw new Error('Model capability overrides are too large.');
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error('Model capability overrides must be valid JSON.'); }
  if (!Array.isArray(decoded) || decoded.length > MAX_OVERRIDE_RECORDS) throw new Error('Invalid model capability override list.');
  const records = decoded.map(parseOverride);
  const keys = records.map(identityKey);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate model capability override.');
  return records.sort((a, b) => identityKey(a).localeCompare(identityKey(b)));
}

export function serializeModelCapabilityOverrides(records: readonly ModelCapabilityOverride[]): string {
  return JSON.stringify(parseModelCapabilityOverrides(JSON.stringify(records)));
}

export function updateModelCapabilityOverride(
  records: readonly ModelCapabilityOverride[],
  identity: ModelIdentity,
  patch: OverridePatch,
): readonly ModelCapabilityOverride[] {
  const current = records.find((record) => identityKey(record) === identityKey(identity));
  const values = Object.fromEntries(CAPABILITY_FIELDS.flatMap((key) => {
    const value = key in patch ? patch[key] : current?.[key];
    return value === undefined ? [] : [[key, value]];
  }));
  const next = records.filter((record) => identityKey(record) !== identityKey(identity));
  if (Object.keys(values).length > 0) next.push({ ...identity, ...values });
  return parseModelCapabilityOverrides(JSON.stringify(next));
}

export function findModelCapabilityOverride(
  records: readonly ModelCapabilityOverride[],
  identity: ModelIdentity,
): ModelCapabilityOverride | undefined {
  return records.find((record) => identityKey(record) === identityKey(identity));
}

/**
 * Vision-capable model ids for a provider from the models.dev catalog,
 * with the provider's currently configured model appended when it is not
 * listed (custom/local model ids must stay selectable). Cloud providers
 * with no vision models in the catalog yield an empty list; local providers
 * (Ollama/LM Studio) keep their configured model so local vision models
 * such as llava remain selectable.
 */
export function listVisionModels(
  provider: LlmProvider,
  configuredModel?: string,
): readonly string[] {
  const catalog = catalogProviders[provider] ?? {};
  const ids = Object.keys(catalog).filter((id) => (catalog[id]?.input ?? []).includes('image'));
  if (ids.length === 0 && provider !== 'ollama' && provider !== 'lmstudio') return [];
  if (configuredModel && !ids.includes(configuredModel)) return [...ids, configuredModel];
  return ids;
}

export function resolveModelCapabilities(
  identity: ModelIdentity,
  records: readonly ModelCapabilityOverride[] = [],
): ModelCapabilities {
  // Snapshot model ids (e.g. qwen3.7-plus-2026-05-26) share the base model's
  // catalog entry: match exact first, then the longest `base-` prefix.
  const catalog = catalogProviders[identity.provider] ?? {};
  const model = catalog[identity.modelId]
    ?? (() => {
      const snapshotBase = Object.keys(catalog)
        .filter((id) => identity.modelId.startsWith(`${id}-`))
        .sort((a, b) => b.length - a.length)[0];
      return snapshotBase ? catalog[snapshotBase] : undefined;
    })();
  const override = findModelCapabilityOverride(records, identity);
  const context = override?.contextWindowTokens !== undefined
    ? exact(override.contextWindowTokens, 'settings-override')
    : model?.contextWindowTokens
      ? exact(model.contextWindowTokens, 'catalog')
      : fallback(UNKNOWN_CONTEXT_TOKENS);
  const catalogOutput = positiveInteger(model?.maxOutputTokens);
  const outputValue = Math.min(override?.maxOutputTokens ?? catalogOutput ?? UNKNOWN_OUTPUT_TOKENS, context.value);
  const output = override?.maxOutputTokens !== undefined
    ? exact(outputValue, 'settings-override')
    : catalogOutput
      ? exact(outputValue, 'catalog')
      : fallback(outputValue);
  const catalogInput = positiveInteger(model?.maxInputTokens);
  const inputValue = Math.min(
    override?.maxInputTokens ?? catalogInput ?? Math.max(1, context.value - output.value),
    context.value,
  );
  const input = override?.maxInputTokens !== undefined
    ? exact(inputValue, 'settings-override')
    : catalogInput
      ? exact(inputValue, 'catalog')
      : fallback(inputValue);
  const tools = override?.supportsTools !== undefined ? exact(override.supportsTools, 'settings-override')
    : typeof model?.supportsTools === 'boolean' ? exact(model.supportsTools, 'catalog') : fallback(false);
  const images = override?.supportsImages !== undefined ? exact(override.supportsImages, 'settings-override')
    : model ? exact(model.input.includes('image'), 'catalog') : fallback(false);
  const reasoning = override?.supportsReasoning !== undefined ? exact(override.supportsReasoning, 'settings-override')
    : typeof model?.reasoning === 'boolean' ? exact(model.reasoning, 'catalog') : fallback(false);
  const efforts = override?.reasoningEfforts !== undefined ? exact(override.reasoningEfforts, 'settings-override')
    : model ? exact(model.reasoningEfforts, 'catalog') : fallback([]);
  const defaultEffort = override?.defaultReasoningEffort
    ? exact(override.defaultReasoningEffort, 'settings-override') : undefined;
  return { contextWindowTokens: context, maxInputTokens: input, maxOutputTokens: output,
    supportsTools: tools, supportsImages: images, supportsReasoning: reasoning,
    reasoningEfforts: efforts,
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}) };
}
