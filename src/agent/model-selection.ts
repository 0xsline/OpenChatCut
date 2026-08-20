import type { CodexAgentModel, CodexAgentStatus } from '../../shared/codex-agent';
import { loadAgentModelPref, saveAgentModelPref } from '../persist/sessionPrefs';
import {
  LLM_PROVIDER_PRESETS,
  defaultModelForProvider,
  isLocalLlmProvider,
  llmProviderConfigNames,
  normalizeLlmProvider,
  type LlmProvider,
  type OpenAiApiMode,
} from '../../shared/llm-providers';
import {
  MODEL_CAPABILITY_OVERRIDES_KEY,
  parseModelCapabilityOverrides,
  resolveModelCapabilities,
  type ModelCapabilities,
  type ModelCapabilityOverride,
  type ModelIdentity,
} from '../../shared/model-capabilities';
import { setLlmConfig } from './providerConfig';

interface KeyStateLike {
  readonly configured: boolean;
}

export interface AgentModelChoice {
  readonly id: string;
  readonly backend: 'api' | 'codex';
  readonly provider: LlmProvider;
  readonly providerLabel: string;
  readonly model: string;
  readonly requestModel?: string;
  readonly openAiApiMode?: OpenAiApiMode;
  readonly reasoningEffort?: string;
  readonly capabilities: ModelCapabilities;
}

export interface AgentModelSnapshot {
  readonly choices: readonly AgentModelChoice[];
  readonly activeId: string;
  readonly loaded: boolean;
}

let snapshot: AgentModelSnapshot = { choices: [], activeId: '', loaded: false };
let apiModelChoices: readonly AgentModelChoice[] = [];
let codexModelChoices: readonly AgentModelChoice[] = [];
let capabilityOverrides: readonly ModelCapabilityOverride[] = [];
let codexStatus: CodexAgentStatus | null = null;
let codexSavedModel = '';
let codexSavedReasoningEffort = '';
let codexDiscoveredModels: readonly CodexAgentModel[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(choices: readonly AgentModelChoice[], activeId: string, loaded = snapshot.loaded): void {
  snapshot = { choices, activeId, loaded };
  emit();
}

function commitChoices(
  choices: readonly AgentModelChoice[],
  activeId: string,
  loaded = snapshot.loaded,
  fallbackApi?: AgentModelChoice,
): void {
  const active = choices.find((choice) => choice.id === activeId);
  const runtimeApi = active?.backend === 'api' ? active : fallbackApi;
  if (runtimeApi) {
    setLlmConfig(runtimeApi.provider, runtimeApi.model, runtimeApi.openAiApiMode);
  }
  commit(choices, activeId, loaded);
}

function safeOverrides(raw: unknown): readonly ModelCapabilityOverride[] {
  try { return parseModelCapabilityOverrides(raw); } catch { return []; }
}

function modelCapabilities(identity: ModelIdentity): ModelCapabilities {
  return resolveModelCapabilities(identity, capabilityOverrides);
}

function apiChoices(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): readonly AgentModelChoice[] {
  return LLM_PROVIDER_PRESETS.flatMap((preset): AgentModelChoice[] => {
    const names = llmProviderConfigNames(preset.id);
    const savedModel = models[names.model]?.trim() ?? '';
    if (isLocalLlmProvider(preset.id) ? !savedModel : !keys[names.apiKey]?.configured) return [];
    const model = savedModel || defaultModelForProvider(preset.id);
    const identity: ModelIdentity = { backend: 'api', provider: preset.id, modelId: model };
    return [{
      id: `${preset.id}:${model}`,
      backend: 'api',
      provider: preset.id,
      providerLabel: preset.label,
      model,
      ...(preset.id === 'openai'
        ? { openAiApiMode: models.LLM_OPENAI_API_MODE === 'chat' ? 'chat' : 'responses' }
        : {}),
      capabilities: modelCapabilities(identity),
    }];
  });
}

function chooseInitialApiId(
  choices: readonly AgentModelChoice[],
  models: Record<string, string>,
): string {
  const preferred = normalizeLlmProvider(models.LLM_PROVIDER);
  return choices.find((choice) => choice.provider === preferred)?.id ?? choices[0]?.id ?? '';
}

function allChoices(): readonly AgentModelChoice[] {
  return [...apiModelChoices, ...codexModelChoices];
}
function rebuildCodexChoices(): void {
  if (!codexStatus?.installed || codexStatus.account?.type === 'apiKey') {
    codexModelChoices = [];
    return;
  }
  const entries = codexDiscoveredModels.length > 0
    ? codexDiscoveredModels
    : (codexSavedModel.trim() ? [{ id: codexSavedModel.trim() }] : []);
  codexModelChoices = entries.map((entry) => {
    const requested = entry.id === codexSavedModel;
    const identity: ModelIdentity = { backend: 'codex', provider: 'openai', modelId: entry.id };
    const capabilities = modelCapabilities(identity);
    return {
      id: `codex:${entry.id}`,
      backend: 'codex',
      provider: 'openai',
      providerLabel: 'OpenAI Codex',
      model: entry.id,
      ...(requested ? { requestModel: entry.id } : {}),
      reasoningEffort: selectedReasoningEffort(codexSavedReasoningEffort, capabilities),
      capabilities,
    };
  });
}



export function applyAgentModelStatus(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): void {
  capabilityOverrides = safeOverrides(models[MODEL_CAPABILITY_OVERRIDES_KEY]);
  apiModelChoices = apiChoices(keys, models);
  codexSavedModel = models.CODEX_MODEL?.trim() ?? codexSavedModel;
  codexSavedReasoningEffort = models.CODEX_REASONING_EFFORT?.trim() ?? codexSavedReasoningEffort;
  rebuildCodexChoices();
  const choices = allChoices();
  const initialApiId = chooseInitialApiId(apiModelChoices, models);
  const preferred = loadAgentModelPref();
  const preserved = choices.some((choice) => choice.id === preferred) ? preferred
    : choices.some((choice) => choice.id === snapshot.activeId) ? snapshot.activeId : '';
  commitChoices(choices, preserved || codexModelChoices[0]?.id || initialApiId || choices[0]?.id || '', true,
    apiModelChoices.find((choice) => choice.id === initialApiId));
}

function selectedReasoningEffort(requested: string | undefined, capabilities: ModelCapabilities): string {
  const effort = requested?.trim() ?? '';
  if (!effort) return '';
  if (!capabilities.supportsReasoning.estimated && !capabilities.supportsReasoning.value) return '';
  const supported = capabilities.reasoningEfforts.value;
  return supported.length === 0 || supported.includes(effort)
    ? effort
    : capabilities.defaultReasoningEffort?.value ?? '';
}


export function applyCodexAgentStatus(
  status: CodexAgentStatus,
  savedModel?: string,
  savedReasoningEffort?: string,
  discoveredModels?: readonly CodexAgentModel[],
): void {
  codexStatus = status;
  codexSavedModel = savedModel?.trim() ?? codexSavedModel;
  codexSavedReasoningEffort = savedReasoningEffort?.trim() ?? codexSavedReasoningEffort;
  if (discoveredModels) codexDiscoveredModels = discoveredModels;
  rebuildCodexChoices();
  const choices = allChoices();
  const preffered = loadAgentModelPref();
  const preserved = choices.some((choice) => choice.id === preffered) ? preffered
    : choices.some((choice) => choice.id === snapshot.activeId) ? snapshot.activeId : '';
  commitChoices(choices, preserved || codexModelChoices[0]?.id || choices[0]?.id || '', true);
}

export function getAgentModelSnapshot(): AgentModelSnapshot {
  return snapshot;
}

export function subscribeAgentModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isAgentModelReady(state: AgentModelSnapshot = snapshot): boolean {
  return state.loaded
    && Boolean(state.activeId)
    && state.choices.some((choice) => choice.id === state.activeId);
}

export function getActiveAgentModelChoice(): AgentModelChoice | undefined {
  return snapshot.choices.find((choice) => choice.id === snapshot.activeId);
}

export function selectAgentModel(id: string): void {
  const choice = snapshot.choices.find((candidate) => candidate.id === id);
  if (!choice) return;
  commitChoices(snapshot.choices, choice.id);
  saveAgentModelPref(id);
}
