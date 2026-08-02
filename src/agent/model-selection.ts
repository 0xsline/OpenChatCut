import type { CodexAgentStatus } from '../../shared/codex-agent';
import {
  LLM_PROVIDER_PRESETS,
  defaultModelForProvider,
  isLocalLlmProvider,
  llmProviderConfigNames,
  normalizeLlmProvider,
  type LlmProvider,
} from '../../shared/llm-providers';
import { setLlmConfig } from './providerConfig';

interface KeyStateLike {
  readonly configured: boolean;
}

export type AgentModelBackend = 'api' | 'codex';

export interface AgentModelChoice {
  readonly id: string;
  readonly backend: AgentModelBackend;
  readonly provider: LlmProvider;
  readonly providerLabel: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface AgentModelSnapshot {
  readonly activeId: string;
  readonly choices: readonly AgentModelChoice[];
  readonly loaded: boolean;
}

export function isAgentModelReady(state: AgentModelSnapshot): boolean {
  return state.loaded
    && state.activeId.length > 0
    && state.choices.some((choice) => choice.id === state.activeId);
}

const EMPTY: AgentModelSnapshot = { activeId: '', choices: [], loaded: false };
let snapshot = EMPTY;
const listeners = new Set<() => void>();

function emit(next: AgentModelSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function currentChoice(): AgentModelChoice | undefined {
  return snapshot.choices.find((choice) => choice.id === snapshot.activeId);
}

function apiChoices(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): AgentModelChoice[] {
  return LLM_PROVIDER_PRESETS.flatMap((preset): AgentModelChoice[] => {
    const names = llmProviderConfigNames(preset.id);
    const savedModel = models[names.model]?.trim();
    if (isLocalLlmProvider(preset.id) ? !savedModel : !keys[names.apiKey]?.configured) return [];
    const model = savedModel || defaultModelForProvider(preset.id);
    return [{
      id: `${preset.id}:${model}`,
      backend: 'api',
      provider: preset.id,
      providerLabel: preset.label,
      model,
    }];
  });
}

export function subscribeAgentModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentModelSnapshot(): AgentModelSnapshot {
  return snapshot;
}

export function getActiveAgentModelChoice(): AgentModelChoice | undefined {
  return currentChoice();
}

export function applyAgentModelStatus(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): void {
  const previous = currentChoice();
  const choices = [
    ...apiChoices(keys, models),
    ...snapshot.choices.filter((choice) => choice.backend === 'codex'),
  ];
  const savedProvider = normalizeLlmProvider(models.LLM_PROVIDER);
  const configuredApi = choices.find(
    (choice) => choice.backend === 'api' && choice.provider === savedProvider,
  ) ?? choices.find((choice) => choice.backend === 'api');
  const preferred = previous?.backend === 'codex'
    ? choices.find((choice) => choice.id === previous.id)
    : configuredApi;
  const active = preferred ?? choices[0];
  if (configuredApi) {
    setLlmConfig(configuredApi.provider, configuredApi.model, models.LLM_OPENAI_API_MODE);
  }
  emit({ activeId: active?.id ?? '', choices, loaded: true });
}

export function applyCodexAgentStatus(
  status: CodexAgentStatus,
  savedModel?: string,
  savedReasoningEffort?: string,
): void {
  const previous = currentChoice();
  const api = snapshot.choices.filter((choice) => choice.backend === 'api');
  const model = savedModel?.trim() ?? '';
  const codex: AgentModelChoice[] = status.installed && status.account?.type === 'chatgpt'
    ? [{
        id: `codex:${model || 'default'}`,
        backend: 'codex',
        provider: 'openai',
        providerLabel: 'OpenAI Codex',
        model,
        reasoningEffort: savedReasoningEffort?.trim() ?? '',
      }]
    : [];
  const choices = [...api, ...codex];
  const active = choices.find((choice) => choice.id === previous?.id)
    ?? (previous?.backend === 'codex' ? codex[0] : undefined)
    ?? choices[0];
  if (active?.backend === 'api') setLlmConfig(active.provider, active.model);
  emit({ activeId: active?.id ?? '', choices, loaded: true });
}

export function selectAgentModel(id: string): void {
  const active = snapshot.choices.find((choice) => choice.id === id);
  if (!active || active.id === snapshot.activeId) return;
  if (active.backend === 'api') setLlmConfig(active.provider, active.model);
  emit({ ...snapshot, activeId: active.id });
}
