// Custom agent model IDs per provider (Frame / ZCode-style: add models yourself).
// Stored in localStorage only — secrets stay in server keystore; this is just model name lists.
import {
  LLM_PROVIDER_PRESETS,
  normalizeLlmProvider,
  type LlmProvider,
} from '../../shared/llm-providers';

const KEY = 'cc.customAgentModels.v1';

export type CustomModelsStore = Partial<Record<LlmProvider, string[]>>;

function isProviderId(value: string): value is LlmProvider {
  return LLM_PROVIDER_PRESETS.some((preset) => preset.id === value);
}

export function loadCustomModels(): CustomModelsStore {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const out: CustomModelsStore = {};
    for (const [provider, list] of Object.entries(raw)) {
      if (!isProviderId(provider) || !Array.isArray(list)) continue;
      const models = [...new Set(
        list
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean),
      )];
      if (models.length) out[provider] = models;
    }
    return out;
  } catch {
    return {};
  }
}

function saveCustomModels(store: CustomModelsStore): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* private mode */
  }
}

export function listCustomModels(provider: unknown): string[] {
  const id = normalizeLlmProvider(provider);
  return loadCustomModels()[id] ?? [];
}

/** Add a model id under a provider. Returns false if empty/duplicate. */
export function addCustomModel(provider: unknown, model: string): boolean {
  const id = normalizeLlmProvider(provider);
  const name = model.trim();
  if (!name) return false;
  const store = loadCustomModels();
  const current = store[id] ?? [];
  if (current.includes(name)) return false;
  store[id] = [...current, name];
  saveCustomModels(store);
  return true;
}

export function removeCustomModel(provider: unknown, model: string): boolean {
  const id = normalizeLlmProvider(provider);
  const name = model.trim();
  const store = loadCustomModels();
  const current = store[id] ?? [];
  if (!current.includes(name)) return false;
  const next = current.filter((item) => item !== name);
  if (next.length) store[id] = next;
  else delete store[id];
  saveCustomModels(store);
  return true;
}

export function isCustomModel(provider: unknown, model: string): boolean {
  return listCustomModels(provider).includes(model.trim());
}
