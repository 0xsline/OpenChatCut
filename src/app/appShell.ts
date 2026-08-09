import { useCallback, useEffect, useState } from 'react';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../agent/capabilities';
import { fetchCodexModels, fetchCodexStatus } from '../agent/codex/client';
import { applyAgentModelStatus, applyCodexAgentStatus } from '../agent/model-selection';
import type { ProjectDoc, TimelineState } from '../editor/types';
import {
  createProject,
  docFromTimeline,
  hasProjectHistory,
  listProjects,
} from '../persist/projectStore';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { warmUpLocalAsr } from '../transcript/local-asr';
import {
  preferredTranscriptionProvider,
  TRANSCRIPTION_PROVIDER_CHANGE_EVENT,
} from '../transcript/provider';

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
  const [keyResult, codexResult] = await Promise.allSettled([
    fetch('/api/keys').then(async (response): Promise<LiveAgentStatus> => {
      if (!response.ok) throw new Error('Agent key status is unavailable.');
      return response.json() as Promise<LiveAgentStatus>;
    }),
    fetchCodexStatus(),
  ]);
  if (!isActive()) return;
  let savedCodexModel: string | undefined;
  let savedCodexReasoningEffort: string | undefined;
  if (keyResult.status === 'fulfilled') {
    const { caps, keys, models } = keyResult.value;
    if (caps) applyLiveCaps(caps);
    if (keys) applyLiveKeyStatus(keys);
    if (models) {
      applyLiveModels(models);
      applyAgentModelStatus(keys ?? {}, models);
      savedCodexModel = models.CODEX_MODEL;
      savedCodexReasoningEffort = models.CODEX_REASONING_EFFORT;
    }
  }
  if (codexResult.status !== 'fulfilled') return;
  const modelResult = codexResult.value.account?.type === 'chatgpt'
    ? await fetchCodexModels().catch(() => null)
    : null;
  if (!isActive()) return;
  applyCodexAgentStatus(
    codexResult.value,
    savedCodexModel,
    savedCodexReasoningEffort,
    modelResult && !modelResult.error ? modelResult.models : [],
  );
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

export function useLocalAsrWarmup(routeName: AppRoute['name']): void {
  useEffect(() => {
    if (routeName !== 'editor') return;
    let alive = true;
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      if (preferredTranscriptionProvider() !== 'local') return;
      timer = window.setTimeout(() => {
        void fetch('/api/asr-models', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
          .then((body: { models?: { modelId?: string; downloaded?: boolean }[] } | null) => {
            if (!alive || !Array.isArray(body?.models)) return;
            const downloadedIds = body.models
              .filter((model) => model.downloaded && typeof model.modelId === 'string')
              .map((model) => model.modelId as string);
            if (downloadedIds.length > 0) void warmUpLocalAsr(downloadedIds);
          });
      }, 4000);
    };
    schedule();
    window.addEventListener(TRANSCRIPTION_PROVIDER_CHANGE_EVENT, schedule);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(TRANSCRIPTION_PROVIDER_CHANGE_EVENT, schedule);
    };
  }, [routeName]);
}

export function useProjects(): {
  projects: ProjectMeta[] | null;
  refresh: () => Promise<void>;
} {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const refresh = useCallback(async () => { setProjects(await listProjects()); }, []);
  useEffect(() => {
    void (async () => {
      let list = await listProjects();
      if (list.length === 0 && !(await hasProjectHistory())) {
        list = [await createProject('示例工程', await seedDoc())];
      }
      setProjects(list);
    })();
  }, []);
  return { projects, refresh };
}
