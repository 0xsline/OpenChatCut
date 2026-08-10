import {
  useCallback, useEffect, useMemo, useRef, useState,
  type Dispatch, type MutableRefObject, type SetStateAction,
} from 'react';
import type { MediaAsset } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { isSemanticMedia } from './mediaFrames';
import { indexSemanticAssets, isAbortError, loadWithFallback } from './semanticOperations';
import { SemanticClient } from './semanticClient';
import { rankSemanticMatches } from './vectorSearch';
import { clearSemanticVectors, hybridSearchRemote, pruneSemanticVectors, readSemanticVectors, searchSemanticVectorsRemote } from './vectorStore';
import { fetchModelPackCatalog, fetchModelPackTask, installModelPack } from '../../../shared/model-packs/client';
import type { ModelPackId } from '../../../shared/model-packs/catalog';
import {
  MAX_SEMANTIC_QUERY_LENGTH,
  type DuplicateMatch, type HybridTextHit, type SemanticDevice, type SemanticMatch, type SemanticVectorRecord,
} from './types';

export type SemanticStatus = 'idle' | 'loading' | 'ready' | 'indexing' | 'searching' | 'error';

export interface SemanticSearchState {
  status: SemanticStatus;
  device: SemanticDevice | null;
  modelProgress: number;
  indexedAssets: number;
  totalAssets: number;
  skippedAssets: number;
  matches: SemanticMatch[];
  textHits: HybridTextHit[];
  duplicates: DuplicateMatch[];
  error: string | null;
  /** Visual-semantics model pack state ('skipped' = never probed / not needed). */
  pack: 'checking' | 'absent' | 'downloading' | 'installed' | 'error' | 'skipped';
  packProgress: number;
}

const initialState: SemanticSearchState = {
  status: 'idle', device: null, modelProgress: 0, indexedAssets: 0, totalAssets: 0, skippedAssets: 0,
  matches: [], textHits: [], duplicates: [], error: null, pack: 'skipped', packProgress: 0,
};

const SEMANTIC_PACK_ID: ModelPackId = 'visual-semantics-lite';
const PACK_POLL_MS = 1500;
const PACK_POLL_MAX_ROUNDS = 400; // ~10 minutes

async function probeSemanticPack(): Promise<SemanticSearchState['pack']> {
  try {
    const packs = await fetchModelPackCatalog();
    const pack = packs.find((entry) => entry.id === SEMANTIC_PACK_ID);
    if (!pack) return 'skipped';
    if (pack.status === 'absent') return 'absent';
    if (pack.status === 'downloading') return 'downloading';
    if (pack.status === 'installed') return 'installed';
    return 'error';
  } catch {
    return 'skipped'; // probe is best-effort; never disturb the default path
  }
}

const preferredDevice = (): SemanticDevice => ('gpu' in navigator ? 'webgpu' : 'wasm');
type StateSetter = Dispatch<SetStateAction<SemanticSearchState>>;
interface SemanticSnapshot {
  scopeId: string;
  assets: MediaAsset[];
}
type SnapshotRef = MutableRefObject<SemanticSnapshot>;

export function useSemanticSearch(scopeId: string, assets: MediaAsset[]) {
  const lifecycle = useSemanticLifecycle(scopeId, assets);
  const index = useIndexSemantic(scopeId, assets, lifecycle, lifecycle.refresh);
  const startEnable = useEnableSemantic(lifecycle.client, lifecycle.operation, lifecycle.setState, lifecycle.refresh);
  const enable = useCallback(async () => {
    const ready = await startEnable();
    if (ready && lifecycle.modelChanged.current) {
      lifecycle.modelChanged.current = false;
      await index();
    }
  }, [index, lifecycle.modelChanged, startEnable]);

  // Probe the model-pack status once when the panel is idle (never forces a
  // download; the guidance UI only appears when the pack is absent).
  const packStatus = lifecycle.state.status;
  const packSetState = lifecycle.setState;
  useEffect(() => {
    if (packStatus !== 'idle' && packStatus !== 'error') return;
    let alive = true;
    void probeSemanticPack().then((pack) => {
      if (alive) packSetState((current) => ({ ...current, pack }));
    });
    return () => { alive = false; };
  }, [packSetState, packStatus]);

  /** Download the visual-semantics pack, then enable the model. */
  const setState = lifecycle.setState;
  const installAndEnable = useCallback(async () => {
    setState((current) => ({
      ...current, pack: 'downloading', packProgress: 0, error: null,
    }));
    try {
      await installModelPack(SEMANTIC_PACK_ID, {});
      for (let round = 0; round < PACK_POLL_MAX_ROUNDS; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, PACK_POLL_MS));
        const task = await fetchModelPackTask(SEMANTIC_PACK_ID);
        if (task && task.status === 'downloading') {
          const progress = task.bytesTotal > 0
            ? Math.min(100, Math.round(task.bytesDone / task.bytesTotal * 100))
            : 0;
          setState((current) => ({ ...current, packProgress: progress }));
          continue;
        }
        break;
      }
      setState((current) => ({ ...current, pack: 'installed', packProgress: 100 }));
      await enable();
    } catch {
      setState((current) => ({
        ...current, pack: 'error', packProgress: 0,
        error: '模型包下载失败，请到 设置 → 本地模型 重试',
      }));
    }
  }, [enable, setState]);
  const queries = useSemanticQueries(
    lifecycle.client, lifecycle.records, lifecycle.snapshot, lifecycle.snapshotRef, lifecycle.setState,
  );
  const cancel = useCancelSemantic(
    lifecycle.client, lifecycle.operation, lifecycle.duplicateOperation, lifecycle.setState,
  );
  return { state: lifecycle.state, enable, installAndEnable, index, cancel, ...queries };
}

interface SemanticRuntime {
  client: MutableRefObject<SemanticClient>;
  operation: MutableRefObject<AbortController | null>;
  duplicateOperation: MutableRefObject<AbortController | null>;
  records: MutableRefObject<SemanticVectorRecord[]>;
  modelChanged: MutableRefObject<boolean>;
  setState: StateSetter;
}

function useSemanticLifecycle(scopeId: string, assets: MediaAsset[]) {
  const [state, setState] = useState<SemanticSearchState>(initialState);
  const client = useRef<SemanticClient | null>(null);
  const operation = useRef<AbortController | null>(null);
  const duplicateOperation = useRef<AbortController | null>(null);
  const records = useRef<SemanticVectorRecord[]>([]);
  const modelChanged = useRef(false);
  if (client.current === null) client.current = new SemanticClient();
  const runtime = useMemo<SemanticRuntime>(() => ({
    client: client as MutableRefObject<SemanticClient>,
    operation, duplicateOperation, records, modelChanged, setState,
  }), [client, duplicateOperation, modelChanged, operation, records, setState]);
  const snapshot = useMemo<SemanticSnapshot>(() => ({ scopeId, assets }), [scopeId, assets]);
  const snapshotRef = useRef(snapshot);
  const previousScope = useRef(scopeId);
  snapshotRef.current = snapshot;
  useSemanticSnapshotEffects(scopeId, assets, snapshot, snapshotRef, previousScope, runtime);
  const refresh = useSemanticRefresh(snapshot, snapshotRef, runtime);
  return { state, ...runtime, snapshot, snapshotRef, refresh };
}

function useSemanticSnapshotEffects(
  scopeId: string,
  assets: MediaAsset[],
  snapshot: SemanticSnapshot,
  snapshotRef: SnapshotRef,
  previousScope: MutableRefObject<string>,
  runtime: SemanticRuntime,
): void {
  useEffect(() => {
    runtime.operation.current?.abort();
    runtime.operation.current = null;
    runtime.duplicateOperation.current?.abort();
    runtime.duplicateOperation.current = null;
    if (previousScope.current !== scopeId) {
      previousScope.current = scopeId;
      runtime.client.current.cancel();
      runtime.records.current = [];
      runtime.modelChanged.current = false;
      runtime.setState(initialState);
    }
  }, [assets, previousScope, runtime, scopeId]);
  useEffect(
    () => pruneMissingAssets(
      snapshot, snapshotRef, runtime.records, runtime.modelChanged, runtime.setState,
    ),
    [runtime, snapshot, snapshotRef],
  );
  useEffect(() => () => {
    runtime.operation.current?.abort();
    runtime.duplicateOperation.current?.abort();
    runtime.client.current.cancel();
  }, [runtime]);
}

function useSemanticRefresh(
  snapshot: SemanticSnapshot,
  snapshotRef: SnapshotRef,
  runtime: SemanticRuntime,
): () => Promise<void> {
  return useCallback(async () => {
    const controller = new AbortController();
    runtime.duplicateOperation.current?.abort();
    runtime.duplicateOperation.current = controller;
    try {
      const stored = await readSemanticVectors(snapshot.scopeId);
      if (snapshotRef.current !== snapshot) throw semanticStaleResultError();
      const revisions = new Map(snapshot.assets.map((asset) => [asset.id, sourceRevisionOf(asset)]));
      const nextRecords = stored.filter((record) => (
        record.sourceRevision === revisions.get(record.assetId)
      ));
      const duplicates = await runtime.client.current.findDuplicateAssets(
        nextRecords, undefined, controller.signal,
      );
      if (snapshotRef.current !== snapshot) throw semanticStaleResultError();
      runtime.records.current = nextRecords;
      const indexedAssets = new Set(nextRecords.map((record) => record.assetId)).size;
      runtime.setState((current) => ({ ...current, indexedAssets, duplicates }));
    } finally {
      if (runtime.duplicateOperation.current === controller) runtime.duplicateOperation.current = null;
    }
  }, [runtime, snapshot, snapshotRef]);
}

function pruneMissingAssets(
  snapshot: SemanticSnapshot,
  snapshotRef: SnapshotRef,
  records: MutableRefObject<SemanticVectorRecord[]>,
  modelChanged: MutableRefObject<boolean>,
  setState: StateSetter,
) {
  const revisions = new Map(snapshot.assets.map((asset) => [asset.id, sourceRevisionOf(asset)]));
  const ids = new Set(revisions.keys());
  records.current = records.current.filter((record) => (
    record.sourceRevision === revisions.get(record.assetId)
  ));
  const indexedAssets = new Set(records.current.map((record) => record.assetId)).size;
  setState((current) => ({
    ...current, indexedAssets,
    matches: current.matches.filter((match) => (
      match.sourceRevision === revisions.get(match.assetId)
    )),
    duplicates: current.duplicates.filter((match) => ids.has(match.leftAssetId) && ids.has(match.rightAssetId)),
  }));
  void pruneSemanticVectors(snapshot.scopeId, ids, revisions)
    .then((result) => {
      if (snapshotRef.current === snapshot) {
        modelChanged.current ||= result.staleModelRemoved || result.staleSourceRemoved;
      }
    })
    .catch((reason) => {
      if (snapshotRef.current === snapshot) setFailure(setState, reason);
    });
}

function useEnableSemantic(
  client: MutableRefObject<SemanticClient>,
  operation: MutableRefObject<AbortController | null>,
  setState: StateSetter,
  refresh: () => Promise<void>,
) {
  return useCallback(async () => {
    const controller = new AbortController();
    operation.current = controller;
    const preferred = preferredDevice();
    setState((current) => ({ ...current, status: 'loading', device: preferred, modelProgress: 0, error: null }));
    const load = (device: SemanticDevice, signal: AbortSignal) => loadOnDevice(client, device, signal, setState);
    let ready = false;
    try {
      await loadWithFallback(client.current, preferred, controller.signal, load);
      await refresh();
      setState((current) => ({ ...current, status: 'ready', modelProgress: 100 }));
      ready = true;
    } catch (reason) {
      if (!isAbortError(reason)) setFailure(setState, reason);
    } finally {
      if (operation.current === controller) operation.current = null;
    }
    return ready;
  }, [client, operation, refresh, setState]);
}

async function loadOnDevice(
  client: MutableRefObject<SemanticClient>,
  device: SemanticDevice,
  signal: AbortSignal,
  setState: StateSetter,
) {
  setState((current) => ({ ...current, device }));
  await client.current.load(device, (progress) => {
    if (!signal.aborted && progress != null) setState((current) => ({ ...current, modelProgress: progress }));
  });
  if (signal.aborted) throw new DOMException('Model loading canceled', 'AbortError');
}

interface SemanticLifecycle {
  client: MutableRefObject<SemanticClient>;
  operation: MutableRefObject<AbortController | null>;
  records: MutableRefObject<SemanticVectorRecord[]>;
  setState: StateSetter;
}

function useIndexSemantic(
  scopeId: string,
  assets: MediaAsset[],
  lifecycle: SemanticLifecycle,
  refresh: () => Promise<void>,
) {
  return useCallback(async () => {
    const controller = new AbortController();
    lifecycle.operation.current = controller;
    const indexedIds = new Set(lifecycle.records.current.map((record) => record.assetId));
    const pending = assets.filter(isSemanticMedia).filter((asset) => !indexedIds.has(asset.id));
    lifecycle.setState((current) => ({
      ...current, status: 'indexing', totalAssets: pending.length, indexedAssets: 0, skippedAssets: 0, error: null,
    }));
    try {
      const progress = await indexSemanticAssets(scopeId, lifecycle.client.current, pending, controller.signal, (next) => {
        if (!controller.signal.aborted) {
          lifecycle.setState((current) => ({ ...current, indexedAssets: next.completed, skippedAssets: next.skipped }));
        }
      });
      await refresh();
      if (!controller.signal.aborted) {
        lifecycle.setState((current) => ({ ...current, status: 'ready', skippedAssets: progress.skipped }));
      }
    } catch (reason) {
      if (!isAbortError(reason)) setFailure(lifecycle.setState, reason);
    } finally {
      if (lifecycle.operation.current === controller) lifecycle.operation.current = null;
    }
  }, [scopeId, assets, lifecycle, refresh]);
}

function useSemanticQueries(
  client: MutableRefObject<SemanticClient>,
  records: MutableRefObject<SemanticVectorRecord[]>,
  snapshot: SemanticSnapshot,
  snapshotRef: SnapshotRef,
  setState: StateSetter,
) {
  const searchRequest = useRef(0);
  const search = useCallback(async (text: string) => {
    const request = searchRequest.current + 1;
    searchRequest.current = request;
    const query = text.trim();
    if (!query) return setState((current) => ({ ...current, matches: [] }));
    if (query.length > MAX_SEMANTIC_QUERY_LENGTH) {
      setFailure(setState, new Error('Semantic query exceeds the local limit'));
      return;
    }
    setState((current) => ({ ...current, status: 'searching', matches: [], textHits: [], error: null }));
    try {
      const vector = await client.current.embedText(query);
      if (snapshotRef.current !== snapshot || searchRequest.current !== request) return;
      // Phase C: server-side hybrid search (text FTS5 + visual sqlite-vec,
      // RRF-fused) when available; otherwise local visual ranking only.
      const hybrid = await hybridSearchRemote(snapshot.scopeId, query, vector);
      if (snapshotRef.current !== snapshot || searchRequest.current !== request) return;
      if (hybrid) {
        setState((current) => ({
          ...current,
          status: 'ready',
          matches: hybrid.visual,
          textHits: hybrid.text,
        }));
      } else {
        const matches = await searchSemanticVectorsRemote(snapshot.scopeId, vector)
          ?? rankSemanticMatches(records.current, vector);
        if (snapshotRef.current !== snapshot || searchRequest.current !== request) return;
        setState((current) => ({ ...current, status: 'ready', matches, textHits: [] }));
      }
    } catch (reason) {
      if (snapshotRef.current === snapshot && searchRequest.current === request && !isAbortError(reason)) {
        setFailure(setState, reason);
      }
    }
  }, [client, records, setState, snapshot, snapshotRef]);
  const reset = useCallback(async () => {
    searchRequest.current += 1;
    try {
      await clearSemanticVectors(snapshot.scopeId);
      if (snapshotRef.current !== snapshot) return false;
      records.current = [];
      setState((current) => ({
        ...current, indexedAssets: 0, totalAssets: 0, skippedAssets: 0, matches: [], duplicates: [], error: null,
      }));
      return true;
    } catch (reason) {
      if (snapshotRef.current === snapshot) setFailure(setState, reason);
      return false;
    }
  }, [records, setState, snapshot, snapshotRef]);
  return { search, reset };
}

function useCancelSemantic(
  client: MutableRefObject<SemanticClient>,
  operation: MutableRefObject<AbortController | null>,
  duplicateOperation: MutableRefObject<AbortController | null>,
  setState: StateSetter,
) {
  return useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    duplicateOperation.current?.abort();
    duplicateOperation.current = null;
    client.current.cancel();
    setState((current) => ({
      ...current, status: 'idle', device: null, modelProgress: 0, matches: [], error: null,
    }));
  }, [client, duplicateOperation, operation, setState]);
}

function setFailure(setState: StateSetter, reason: unknown): void {
  const error = reason instanceof Error ? reason.message : String(reason);
  setState((current) => ({ ...current, status: 'error', error }));
}

function semanticStaleResultError(): DOMException {
  return new DOMException('Semantic snapshot changed', 'AbortError');
}
