import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import type { MediaAsset } from '../../editor/types';
import { areModelPacksInstalled } from '../../../shared/model-packs';
import { musicAnalysisStatus, subscribeMusicAnalysis } from './jobs';
import { loadMusicAnalysisForAsset } from './store';
import type { MusicAnalysisStatus } from './types';

const MUSIC_PACK_IDS = ['rhythm-lite', 'music-semantics-lite'] as const;
const MUSIC_PACK_REFRESH_EVENT = 'cc:music-analysis-pack-refresh';

export type MusicAnalysisCardState =
  | (MusicAnalysisStatus & { modelPacksAvailable: boolean | null })
  | { state: 'checking'; modelPacksAvailable: null }
  | { state: 'unavailable'; modelPacksAvailable: false };

interface CachedMusicStatus {
  key: string;
  status: MusicAnalysisStatus;
}

export function requestMusicAnalysisPackRefresh(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MUSIC_PACK_REFRESH_EVENT));
}

function sourceKey(asset: MediaAsset): string {
  return `${asset.id}:${sourceRevisionOf(asset)}`;
}

function readJobStatuses(assets: readonly MediaAsset[]): Map<string, MusicAnalysisStatus> {
  const statuses = new Map<string, MusicAnalysisStatus>();
  for (const asset of assets) statuses.set(asset.id, musicAnalysisStatus(asset.id));
  return statuses;
}

function useInstalledMusicPacks(enabled: boolean): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const check = () => {
      void areModelPacksInstalled(MUSIC_PACK_IDS).then(
        (next) => { if (live) setInstalled(next); },
        () => { if (live) setInstalled(false); },
      );
    };
    check();
    window.addEventListener('focus', check);
    window.addEventListener(MUSIC_PACK_REFRESH_EVENT, check);
    return () => {
      live = false;
      window.removeEventListener('focus', check);
      window.removeEventListener(MUSIC_PACK_REFRESH_EVENT, check);
    };
  }, [enabled]);
  return installed;
}

function useMusicJobStatuses(assets: readonly MediaAsset[]): Map<string, MusicAnalysisStatus> {
  const [statuses, setStatuses] = useState(() => readJobStatuses(assets));
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  useEffect(() => {
    setStatuses(readJobStatuses(assets));
  }, [assets]);
  useEffect(() => subscribeMusicAnalysis(() => {
    setStatuses(readJobStatuses(assetsRef.current));
  }), []);
  return statuses;
}

function useCachedMusicAnalyses(
  assets: readonly MediaAsset[],
  setCached: (id: string, key: string, status: MusicAnalysisStatus) => void,
): void {
  const loaded = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const present = new Set(assets.map((asset) => asset.id));
    for (const id of loaded.current.keys()) if (!present.has(id)) loaded.current.delete(id);
    for (const asset of assets) {
      const key = sourceKey(asset);
      if (loaded.current.get(asset.id) === key) continue;
      loaded.current.set(asset.id, key);
      setCached(asset.id, key, { state: 'idle' });
      void loadMusicAnalysisForAsset(asset).then((analysis) => {
        if (mounted.current && analysis && loaded.current.get(asset.id) === key) {
          setCached(asset.id, key, { state: 'ready', analysis });
        }
      });
    }
  }, [assets, setCached]);
}

export function useMusicAnalysisCards(assets: readonly MediaAsset[]): ReadonlyMap<string, MusicAnalysisCardState> {
  const eligible = useMemo(
    () => assets.filter((asset) => asset.kind === 'audio' || asset.kind === 'video'),
    [assets],
  );
  const installed = useInstalledMusicPacks(eligible.length > 0);
  const jobs = useMusicJobStatuses(eligible);
  const [cached, setCachedMap] = useState<Map<string, CachedMusicStatus>>(() => new Map());
  const setCached = useCallback((id: string, key: string, status: MusicAnalysisStatus) => {
    setCachedMap((current) => new Map(current).set(id, { key, status }));
  }, []);
  useCachedMusicAnalyses(eligible, setCached);
  return useMemo(() => {
    const result = new Map<string, MusicAnalysisCardState>();
    for (const asset of eligible) {
      const currentJob: MusicAnalysisStatus = jobs.get(asset.id) ?? { state: 'idle' };
      const job = currentJob.state === 'ready'
        && currentJob.analysis.sourceRevision !== sourceRevisionOf(asset)
        ? { state: 'idle' as const }
        : currentJob;
      const cachedStatus = cached.get(asset.id);
      const state = job.state === 'idle' && cachedStatus?.key === sourceKey(asset)
        ? cachedStatus.status
        : job;
      if (state.state === 'ready' || state.state === 'queued' || state.state === 'running') {
        result.set(asset.id, { ...state, modelPacksAvailable: installed });
      } else if (installed === null) {
        result.set(asset.id, state.state === 'idle'
          ? { state: 'checking', modelPacksAvailable: null }
          : { ...state, modelPacksAvailable: null });
      } else if (!installed) {
        result.set(asset.id, { state: 'unavailable', modelPacksAvailable: false });
      } else {
        result.set(asset.id, { ...state, modelPacksAvailable: true });
      }
    }
    return result;
  }, [cached, eligible, installed, jobs]);
}
