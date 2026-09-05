import { useCallback, useEffect, useState } from 'react';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../agent/capabilities';
import { fetchCodexModels, fetchCodexStatus } from '../agent/codex/client';
import { fetchCopilotModels, fetchCopilotStatus } from '../agent/copilot/client';
import { applyAgentModelStatus, applyCodexAgentStatus, applyCopilotAgentStatus, selectAgentModel, getActiveAgentModelChoice, getAgentModelSnapshot } from '../agent/model-selection';
import { loadAgentModelPref } from '../persist/sessionPrefs';
import type { ProjectDoc, TimelineState } from '../editor/types';
import {
  createProject,
  docFromTimeline,
  hasProjectHistory,
  listProjects,
} from '../persist/projectStore';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { kvRemoteMode } from '../persist/sharedKv';
import { projectStoreWriteCredential } from '../persist/projectStoreTransport';

export type AppRoute = { name: 'dashboard' } | { name: 'editor'; id: string };

interface LiveAgentStatus {
  readonly caps?: Record<string, boolean>;
  readonly keys?: Record<string, { readonly configured: boolean }>;
  readonly models?: Record<string, string>;
}

const emptyState = (): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  trackOrder: ['track_v1'],
  tracks: { track_v1: { kind: 'video' } },
});

export const emptyProjectDoc = (): ProjectDoc => docFromTimeline(emptyState());
// Keep the sample timeline out of established users' startup bundle; it is needed only on first run.
const seedDoc = async (): Promise<ProjectDoc> => docFromTimeline((await import('../editor/initial')).INITIAL);

function parseHash(): AppRoute {
  const match = window.location.hash.match(/^#\/editor\/(.+)$/);
  return match ? { name: 'editor', id: match[1] } : { name: 'dashboard' };
}

export function navigateTo(hash: string): void {
  window.location.hash = hash;
}

async function syncAgentBackends(isActive: () => boolean): Promise<void> {
  const [keyResult, codexResult, copilotResult] = await Promise.allSettled([
    fetch('/api/keys').then(async (response): Promise<LiveAgentStatus> => {
      if (!response.ok) throw new Error('Agent key status is unavailable.');
      return response.json() as Promise<LiveAgentStatus>;
    }),
    fetchCodexStatus(),
    fetchCopilotStatus(),
  ]);
  if (!isActive()) return;
  let savedCodexModel: string | undefined;
  let savedCodexReasoningEffort: string | undefined;
  let savedCopilotModel: string | undefined;
  let savedCopilotReasoningEffort: string | undefined;
  if (keyResult.status === 'fulfilled') {
    const { caps, keys, models } = keyResult.value;
    if (caps) applyLiveCaps(caps);
    if (keys) applyLiveKeyStatus(keys);
    if (models) {
      applyLiveModels(models);
      applyAgentModelStatus(keys ?? {}, models);
      savedCodexModel = models.CODEX_MODEL;
      savedCodexReasoningEffort = models.CODEX_REASONING_EFFORT;
      savedCopilotModel = models.COPILOT_MODEL;
      savedCopilotReasoningEffort = models.COPILOT_REASONING_EFFORT;
    }
  }
  if (copilotResult.status === 'fulfilled') {
    const copilotModels = copilotResult.value.installed
      && copilotResult.value.supported
      && copilotResult.value.authenticated
      ? await fetchCopilotModels().catch(() => null)
      : null;
    if (!isActive()) return;
    applyCopilotAgentStatus(
      copilotResult.value,
      savedCopilotModel,
      savedCopilotReasoningEffort,
      copilotModels && !copilotModels.error ? copilotModels.models : [],
    );
  }
  if (codexResult.status !== 'fulfilled') return;
  const modelResult = codexResult.value.installed && codexResult.value.account?.type !== 'apiKey'
    ? await fetchCodexModels().catch(() => null)
    : null;
  if (!isActive()) return;
  applyCodexAgentStatus(
    codexResult.value,
    savedCodexModel,
    savedCodexReasoningEffort,
    modelResult && !modelResult.error ? modelResult.models : [],
  );
  // When Codex (the MCP route) is available and the user has never pinned a
  // model, make Codex the active model so the composer starts on the MCP
  // backend instead of the configured default LLM.
  const active = getActiveAgentModelChoice();
  if (active && active.backend !== 'codex' && !loadAgentModelPref()) {
    const codex = getAgentModelSnapshot().choices.find((choice) => choice.backend === 'codex');
    if (codex) selectAgentModel(codex.id);
  }
}

export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function useAgentBackendSync(): void {
  useEffect(() => {
    let alive = true;
    void syncAgentBackends(() => alive);
    return () => { alive = false; };
  }, []);
}

export interface ProjectStartupSource {
  list(): Promise<ProjectMeta[]>;
  hasHistory(): Promise<boolean>;
  canSeedDemo(): boolean;
  createDemo(): Promise<ProjectMeta>;
}

const projectStartupSource: ProjectStartupSource = {
  list: listProjects,
  hasHistory: hasProjectHistory,
  canSeedDemo: () => kvRemoteMode() === 'local' || projectStoreWriteCredential(),
  createDemo: async () => createProject('示例工程', await seedDoc()),
};

export async function loadInitialProjects(
  source: ProjectStartupSource = projectStartupSource,
): Promise<ProjectMeta[]> {
  const list = await source.list();
  if (list.length > 0 || await source.hasHistory()) return list;
  if (!source.canSeedDemo()) return [];
  return [await source.createDemo()];
}

export function useProjects(): {
  projects: ProjectMeta[] | null;
  refresh: () => Promise<void>;
} {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const refresh = useCallback(async () => { setProjects(await listProjects()); }, []);
  useEffect(() => {
    void loadInitialProjects().then(setProjects);
  }, []);
  return { projects, refresh };
}
