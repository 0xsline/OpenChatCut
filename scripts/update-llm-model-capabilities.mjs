import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://models.dev/api.json';
const PROVIDERS = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  kimi: 'moonshotai',
  qwen: 'alibaba',
  glm: 'zhipuai',
  deepseek: 'deepseek',
  stepfun: 'stepfun',
  minimax: 'minimax',
  xiaomi: 'xiaomi',
  mistral: 'mistral',
  openrouter: 'openrouter',
};
// BytePlus ModelArk has no models.dev provider. Hand-vendored from the
// OpenRouter bytedance-seed entries (same Seed models behind ModelArk's
// Ark-compatible endpoint) plus Volcano Engine docs; model ids use the
// ModelArk naming users configure in LLM_BYTEPLUS_MODEL.
const BYTEPLUS_MODELS = {
  'doubao-seed-1.6-flash': {
    contextWindowTokens: 262144,
    maxInputTokens: null,
    maxOutputTokens: 32768,
    input: ['text', 'image', 'video'],
    supportsTools: true,
    reasoning: true,
    reasoningEfforts: [],
  },
  'doubao-seed-1.6-thinking': {
    contextWindowTokens: 262144,
    maxInputTokens: null,
    maxOutputTokens: 32768,
    input: ['text', 'image', 'video'],
    supportsTools: true,
    reasoning: true,
    reasoningEfforts: [],
  },
  'doubao-seed-1.6': {
    contextWindowTokens: 262144,
    maxInputTokens: null,
    maxOutputTokens: 32768,
    input: ['text', 'image', 'video'],
    supportsTools: true,
    reasoning: true,
    reasoningEfforts: [],
  },
  'doubao-seed-2.0-lite': {
    contextWindowTokens: 262144,
    maxInputTokens: null,
    maxOutputTokens: 131072,
    input: ['text', 'image', 'video'],
    supportsTools: true,
    reasoning: true,
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  },
  // Verified directly against GET /api/v3/models (token_limits) on the
  // account's ModelArk endpoint; both were missing from the catalog and
  // fell back to the unknown-model defaults (8192/2048), which made the
  // agent trim requests to a fraction of what these models actually support.
  'deepseek-v3-2-251201': {
    contextWindowTokens: 131072,
    maxInputTokens: 98304,
    maxOutputTokens: 32768,
    input: ['text'],
    supportsTools: true,
    reasoning: true,
    reasoningEfforts: [],
  },
  'seed-2-0-pro-260328': {
    contextWindowTokens: 262144,
    maxInputTokens: 262144,
    maxOutputTokens: 131072,
    input: ['text', 'image', 'video'],
    supportsTools: true,
    reasoning: true,
    reasoningEfforts: [],
  },
};
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../assets/model-capabilities/models-dev.json',
);

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))];
}

function reasoningEfforts(model) {
  if (!Array.isArray(model.reasoning_options)) return [];
  return stringList(model.reasoning_options.flatMap((option) =>
    option?.type === 'effort' ? option.values : [],
  ));
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error('models.dev returned an invalid model record');
  }
  return {
    contextWindowTokens: positiveInteger(model.limit?.context),
    maxInputTokens: positiveInteger(model.limit?.input),
    maxOutputTokens: positiveInteger(model.limit?.output),
    input: stringList(model.modalities?.input),
    supportsTools: typeof model.tool_call === 'boolean' ? model.tool_call : null,
    reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null,
    reasoningEfforts: reasoningEfforts(model),
  };
}

const response = await fetch(SOURCE_URL);
if (!response.ok) throw new Error(`models.dev request failed: HTTP ${response.status}`);
const upstream = await response.json();
const providers = {};

for (const [localId, upstreamId] of Object.entries(PROVIDERS)) {
  const models = upstream[upstreamId]?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error(`models.dev provider is missing: ${upstreamId}`);
  }
  providers[localId] = Object.fromEntries(
    Object.entries(models)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([modelId, model]) => [modelId, normalizeModel(model)]),
  );
}

const catalog = {
  version: 1,
  source: SOURCE_URL,
  providers: { ...providers, byteplus: BYTEPLUS_MODELS },
};
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`Updated ${OUTPUT_PATH}`);
