import {
  allLlmProviderPresets,
  defaultModelForProvider,
  llmProviderConfigNames,
  normalizeLlmProvider,
  parseCustomLlmProvidersJson,
  setCustomLlmProviders,
  type LlmProvider,
} from '../../shared/llm-providers';
import { LLM_CUSTOM_PROVIDERS_KEY } from '../../shared/llm-providers';
import { setLlmConfig } from './client';
import {
  addCustomModel,
  isCustomModel,
  listCustomModels,
  loadCustomModels,
  removeCustomModel,
} from './custom-models';

interface KeyStateLike {
  readonly configured: boolean;
}

export interface AgentModelChoice {
  readonly id: string;
  readonly provider: LlmProvider;
  readonly providerLabel: string;
  readonly model: string;
  /** User-added model id (local list), not the vendor default alone. */
  readonly custom?: boolean;
}

export interface AgentModelSnapshot {
  readonly activeId: string;
  readonly choices: readonly AgentModelChoice[];
  readonly loaded: boolean;
  /** Configured providers (have API key) — for the "add model" form. */
  readonly configuredProviders: readonly { id: LlmProvider; label: string }[];
}

const EMPTY: AgentModelSnapshot = {
  activeId: '',
  choices: [],
  loaded: false,
  configuredProviders: [],
};
let snapshot = EMPTY;
let lastKeys: Record<string, KeyStateLike> = {};
let lastModels: Record<string, string> = {};
const listeners = new Set<() => void>();

function emit(next: AgentModelSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function choiceId(provider: LlmProvider, model: string): string {
  return `${provider}:${model}`;
}

function buildChoices(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): {
  choices: AgentModelChoice[];
  configuredProviders: { id: LlmProvider; label: string }[];
} {
  const customStore = loadCustomModels();
  const configuredProviders: { id: LlmProvider; label: string }[] = [];
  const choices: AgentModelChoice[] = [];

  // Keep runtime catalog in sync with server (custom providers from .env.local)
  if (typeof models[LLM_CUSTOM_PROVIDERS_KEY] === 'string') {
    setCustomLlmProviders(parseCustomLlmProvidersJson(models[LLM_CUSTOM_PROVIDERS_KEY]));
  }

  for (const preset of allLlmProviderPresets()) {
    const names = llmProviderConfigNames(preset.id);
    if (!keys[names.apiKey]?.configured) continue;
    configuredProviders.push({ id: preset.id, label: preset.label });

    const primary = models[names.model]?.trim() || defaultModelForProvider(preset.id);
    const extras = customStore[preset.id] ?? [];
    const modelsForProvider = [...new Set([primary, ...extras])];

    for (const model of modelsForProvider) {
      choices.push({
        id: choiceId(preset.id, model),
        provider: preset.id,
        providerLabel: preset.label,
        model,
        custom: Boolean(preset.custom) || (model !== primary && extras.includes(model)),
      });
    }
  }

  return { choices, configuredProviders };
}

function rebuildFromCache(preferredActiveId?: string): void {
  const { choices, configuredProviders } = buildChoices(lastKeys, lastModels);
  const savedProvider = normalizeLlmProvider(lastModels.LLM_PROVIDER);
  const preferred = preferredActiveId
    ? choices.find((choice) => choice.id === preferredActiveId)
    : undefined;
  const active = preferred
    ?? choices.find((choice) => choice.provider === savedProvider
      && choice.model === (lastModels[llmProviderConfigNames(savedProvider).model]?.trim()
        || defaultModelForProvider(savedProvider)))
    ?? choices.find((choice) => choice.provider === savedProvider)
    ?? choices[0];

  if (active) setLlmConfig(active.provider, active.model, lastModels.LLM_OPENAI_API_MODE);
  emit({
    activeId: active?.id ?? '',
    choices,
    loaded: true,
    configuredProviders,
  });
}

export function subscribeAgentModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentModelSnapshot(): AgentModelSnapshot {
  return snapshot;
}

export function applyAgentModelStatus(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): void {
  lastKeys = keys;
  lastModels = models;
  rebuildFromCache(snapshot.activeId || undefined);
}

function persistSelection(provider: LlmProvider, model: string): void {
  const names = llmProviderConfigNames(provider);
  void fetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      LLM_PROVIDER: provider,
      [names.model]: model,
    }),
  }).catch(() => {
    // Session selection still works if persistence fails.
  });
}

export function selectAgentModel(id: string): void {
  const active = snapshot.choices.find((choice) => choice.id === id);
  if (!active) return;
  if (active.id === snapshot.activeId) return;
  setLlmConfig(active.provider, active.model);
  emit({ ...snapshot, activeId: active.id });
  persistSelection(active.provider, active.model);
}

/** Add a custom model under a configured provider and select it. */
export function addAndSelectCustomModel(provider: unknown, model: string): boolean {
  const id = normalizeLlmProvider(provider);
  const name = model.trim();
  if (!name) return false;
  if (!snapshot.configuredProviders.some((item) => item.id === id)) return false;

  addCustomModel(id, name);
  // Also remember as the saved model for this vendor when it is new.
  lastModels = {
    ...lastModels,
    [llmProviderConfigNames(id).model]: name,
    LLM_PROVIDER: id,
  };
  rebuildFromCache(choiceId(id, name));
  persistSelection(id, name);
  return true;
}

export function removeCustomModelChoice(provider: unknown, model: string): void {
  const id = normalizeLlmProvider(provider);
  if (!removeCustomModel(id, model)) return;
  const wasActive = snapshot.activeId === choiceId(id, model);
  rebuildFromCache(wasActive ? undefined : snapshot.activeId);
  if (wasActive && snapshot.activeId) {
    const active = snapshot.choices.find((c) => c.id === snapshot.activeId);
    if (active) persistSelection(active.provider, active.model);
  }
}

export function choiceIsCustom(choice: AgentModelChoice): boolean {
  return Boolean(choice.custom) || isCustomModel(choice.provider, choice.model);
}

export { listCustomModels };
