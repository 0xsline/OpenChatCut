import {
  useCallback, useEffect, useRef, useState,
  type Dispatch, type MutableRefObject, type SetStateAction,
} from 'react';
import type { MediaAsset } from '../../editor/types';
import { isSemanticMedia } from './mediaFrames';
import { indexSemanticAssets, isAbortError, loadWithFallback } from './semanticOperations';
import { SemanticClient } from './semanticClient';
import { findDuplicateAssets, rankSemanticMatches } from './vectorSearch';
import { clearSemanticVectors, pruneSemanticVectors, readSemanticVectors } from './vectorStore';
import {
  MAX_SEMANTIC_QUERY_LENGTH,
  type DuplicateMatch, type SemanticDevice, type SemanticMatch, type SemanticVectorRecord,
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
  duplicates: DuplicateMatch[];
  error: string | null;
}

const initialState: SemanticSearchState = {
  status: 'idle', device: null, modelProgress: 0, indexedAssets: 0, totalAssets: 0, skippedAssets: 0,
  matches: [], duplicates: [], error: null,
};

const preferredDevice = (): SemanticDevice => ('gpu' in navigator ? 'webgpu' : 'wasm');
type StateSetter = Dispatch<SetStateAction<SemanticSearchState>>;

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
  const queries = useSemanticQueries(scopeId, lifecycle.client, lifecycle.records, lifecycle.setState);
  const cancel = useCancelSemantic(lifecycle.client, lifecycle.operation, lifecycle.setState);
  return { state: lifecycle.state, enable, index, cancel, ...queries };
}

function useSemanticLifecycle(scopeId: string, assets: MediaAsset[]) {
  const [state, setState] = useState<SemanticSearchState>(initialState);
  const client = useRef(new SemanticClient());
  const operation = useRef<AbortController | null>(null);
  const records = useRef<SemanticVectorRecord[]>([]);
  const modelChanged = useRef(false);
  useEffect(
    () => pruneMissingAssets(scopeId, assets, records, modelChanged, setState),
    [scopeId, assets],
  );
  useEffect(() => () => client.current.cancel(), []);
  const refresh = useCallback(async () => {
    records.current = await readSemanticVectors(scopeId);
    const indexedAssets = new Set(records.current.map((record) => record.assetId)).size;
    setState((current) => ({
      ...current, indexedAssets, duplicates: findDuplicateAssets(records.current),
    }));
  }, [scopeId]);
  return { state, setState, client, operation, records, modelChanged, refresh };
}

function pruneMissingAssets(
  scopeId: string,
  assets: MediaAsset[],
  records: MutableRefObject<SemanticVectorRecord[]>,
  modelChanged: MutableRefObject<boolean>,
  setState: StateSetter,
) {
  const ids = new Set(assets.map((asset) => asset.id));
  records.current = records.current.filter((record) => ids.has(record.assetId));
  const indexedAssets = new Set(records.current.map((record) => record.assetId)).size;
  setState((current) => ({
    ...current, indexedAssets,
    matches: current.matches.filter((match) => ids.has(match.assetId)),
    duplicates: current.duplicates.filter((match) => ids.has(match.leftAssetId) && ids.has(match.rightAssetId)),
  }));
  void pruneSemanticVectors(scopeId, ids)
    .then((result) => { modelChanged.current ||= result.staleModelRemoved; })
    .catch((reason) => setFailure(setState, reason));
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
      operation.current = null;
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
        lifecycle.setState((current) => ({ ...current, indexedAssets: next.completed, skippedAssets: next.skipped }));
      });
      await refresh();
      lifecycle.setState((current) => ({ ...current, status: 'ready', skippedAssets: progress.skipped }));
    } catch (reason) {
      if (!isAbortError(reason)) setFailure(lifecycle.setState, reason);
    } finally {
      lifecycle.operation.current = null;
    }
  }, [scopeId, assets, lifecycle, refresh]);
}

function useSemanticQueries(
  scopeId: string,
  client: MutableRefObject<SemanticClient>,
  records: MutableRefObject<SemanticVectorRecord[]>,
  setState: StateSetter,
) {
  const search = useCallback(async (text: string) => {
    const query = text.trim();
    if (!query) return setState((current) => ({ ...current, matches: [] }));
    if (query.length > MAX_SEMANTIC_QUERY_LENGTH) {
      setFailure(setState, new Error('Semantic query exceeds the local limit'));
      return;
    }
    setState((current) => ({ ...current, status: 'searching', matches: [], error: null }));
    try {
      const vector = await client.current.embedText(query);
      setState((current) => ({ ...current, status: 'ready', matches: rankSemanticMatches(records.current, vector) }));
    } catch (reason) {
      setFailure(setState, reason);
    }
  }, [client, records, setState]);
  const reset = useCallback(async () => {
    try {
      await clearSemanticVectors(scopeId);
      records.current = [];
      setState((current) => ({ ...current, indexedAssets: 0, totalAssets: 0, skippedAssets: 0, matches: [], duplicates: [], error: null }));
      return true;
    } catch (reason) {
      setFailure(setState, reason);
      return false;
    }
  }, [scopeId, records, setState]);
  return { search, reset };
}

function useCancelSemantic(
  client: MutableRefObject<SemanticClient>,
  operation: MutableRefObject<AbortController | null>,
  setState: StateSetter,
) {
  return useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    client.current.cancel();
    setState((current) => ({
      ...current, status: 'idle', device: null, modelProgress: 0, matches: [], error: null,
    }));
  }, [client, operation, setState]);
}

function setFailure(setState: StateSetter, reason: unknown): void {
  const error = reason instanceof Error ? reason.message : String(reason);
  setState((current) => ({ ...current, status: 'error', error }));
}
