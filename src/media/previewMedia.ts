import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TimelineState } from '../editor/types';
import { isPreviewable } from './clipPreview';

export interface PreviewProxySource {
  src: string;
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  longGop: boolean;
}

export type PreviewProxyReadiness =
  | { status: 'not-needed'; reason: string }
  | { status: 'ready'; reason: string; previewSrc: string }
  | { status: 'failed'; reason: string; error: string };

export interface PreviewProxyResponse {
  source: PreviewProxySource;
  proxy: PreviewProxyReadiness;
}

export type PreviewProxyState = PreviewProxyReadiness
  | { status: 'loading'; reason: string }
  | { status: 'unavailable'; reason: string };

interface ProxyEntry {
  response: PreviewProxyResponse | null;
  promise: Promise<void> | null;
  controller: AbortController | null;
  listeners: Set<() => void>;
  force: boolean;
}

const proxyEntries = new Map<string, ProxyEntry>();

function proxyEntry(src: string): ProxyEntry {
  let entry = proxyEntries.get(src);
  if (!entry) {
    entry = { response: null, promise: null, controller: null, listeners: new Set(), force: false };
    proxyEntries.set(src, entry);
  }
  return entry;
}

function notify(entry: ProxyEntry): void {
  for (const listener of entry.listeners) listener();
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `preview proxy request failed (${response.status})`;
}

function failedResponse(src: string, error: unknown): PreviewProxyResponse {
  return {
    source: { src, durationMs: 0, width: 0, height: 0, codec: '', longGop: false },
    proxy: {
      status: 'failed',
      reason: 'proxy-request-failed',
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

async function loadProxy(src: string, force: boolean, entry: ProxyEntry): Promise<void> {
  if (entry.promise) {
    await entry.promise;
    if (force && !entry.force && entry.response?.proxy.status !== 'ready') await loadProxy(src, true, entry);
    return;
  }
  if (!force && entry.response) return;
  entry.force = force;
  entry.response = null;
  notify(entry);
  const query = `src=${encodeURIComponent(src)}${force ? '&force=1' : ''}`;
  const controller = new AbortController();
  entry.controller = controller;
  entry.promise = fetch(`/api/preview-proxy?${query}`, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      entry.response = await response.json() as PreviewProxyResponse;
    })
    .catch((error) => {
      if (!controller.signal.aborted) entry.response = failedResponse(src, error);
    })
    .finally(() => {
      if (entry.controller === controller) entry.controller = null;
      entry.promise = null;
      notify(entry);
    });
  await entry.promise;
}

export function requestPreviewProxy(src: string, force = false): Promise<void> {
  if (!isPreviewable(src)) return Promise.resolve();
  return loadProxy(src, force, proxyEntry(src));
}

export function reportPreviewPlaybackFailure(src: string, error = 'preview media failed to play'): void {
  if (!isPreviewable(src)) return;
  const entry = proxyEntry(src);
  if (entry.response?.proxy.status !== 'ready') {
    if (entry.response?.proxy.status !== 'failed') void requestPreviewProxy(src, true);
    return;
  }
  entry.response = {
    ...entry.response,
    proxy: { status: 'failed', reason: 'proxy-playback-failed', error },
  };
  notify(entry);
}

export function mediaPosterUrl(src: string | undefined): string | undefined {
  return isPreviewable(src) ? `/api/media-poster?src=${encodeURIComponent(src)}` : undefined;
}

function stateFor(src: string | undefined): PreviewProxyState {
  if (!isPreviewable(src)) return { status: 'unavailable', reason: 'non-local-source' };
  const entry = proxyEntry(src);
  return entry.response?.proxy ?? { status: 'loading', reason: 'checking-source' };
}

function subscribe(sources: readonly string[], listener: () => void): () => void {
  for (const src of sources) proxyEntry(src).listeners.add(listener);
  return () => {
    for (const src of sources) {
      const entry = proxyEntries.get(src);
      if (!entry) continue;
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.promise) {
        entry.controller?.abort();
        if (proxyEntries.get(src) === entry) proxyEntries.delete(src);
      }
    }
  };
}

function useProxySources(sources: readonly string[], sourceKey: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1);
    const unsubscribe = subscribe(sources, bump);
    for (const src of sources) void requestPreviewProxy(src);
    return unsubscribe;
  }, [sourceKey]);
  return revision;
}

export function usePreviewMediaSource(src: string | undefined, enabled = true) {
  const source = enabled && isPreviewable(src) ? src : '';
  const sources = useMemo(() => source ? [source] : [], [source]);
  const revision = useProxySources(sources, source);
  const proxy = stateFor(source || undefined);
  const previewSrc = proxy.status === 'ready' ? proxy.previewSrc : src;
  return {
    sourceSrc: src,
    previewSrc,
    posterSrc: mediaPosterUrl(source || undefined),
    proxy,
    requestFallback: useCallback(() => {
      if (source) reportPreviewPlaybackFailure(source);
    }, [source]),
    revision,
  };
}

export function usePreviewTimelineState(state: TimelineState) {
  const sources = useMemo(() => [...new Set(state.items
    .filter((item) => item.kind === 'video' && isPreviewable(item.src))
    .map((item) => item.src!))].sort(), [state.items]);
  const sourceKey = sources.join('\u0000');
  const revision = useProxySources(sources, sourceKey);
  const previewState = useMemo<TimelineState>(() => ({
    ...state,
    items: state.items.map((item) => {
      if (item.kind !== 'video' || !item.src) return item;
      const proxy = stateFor(item.src);
      return proxy.status === 'ready' ? { ...item, src: proxy.previewSrc } : item;
    }),
  }), [state, revision]);
  const proxies = sources.map((src) => ({ src, proxy: stateFor(src) }));
  return {
    state: previewState,
    proxies,
    requestFallback: (src: string) => { reportPreviewPlaybackFailure(src); },
  };
}
