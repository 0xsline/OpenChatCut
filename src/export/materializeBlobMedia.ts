import type { ProjectDoc, Timeline } from '../editor/types';
import { t } from '../i18n/locale';
import { createExportFailure, ExportFailureError } from './exportFailure';
import { collectExportMediaPlan, immutableExportSnapshot } from './exportMediaPlan';

/**
 * Blob URLs only exist inside the browser tab that created them and are revoked
 * ~30s after import. Server-side rendering (desktop / headless Remotion) cannot
 * download them at all. Before any export submission, blob sources must be
 * re-published to the local server so the renderer can fetch real bytes.
 */

const MEDIA_FIELD = /(?:^|_)(?:src|url|path|cube|lut)$/i;
const MEDIA_FIELD_SUFFIX = /(?:Src|Url|Path)$/;

function isMediaField(key: string): boolean {
  return MEDIA_FIELD.test(key) || MEDIA_FIELD_SUFFIX.test(key);
}

function isBlobSource(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('blob:');
}

interface MaterializeFailure {
  source: string;
  name: string;
  message: string;
}

export interface MaterializeBlobMediaOptions {
  /** Exact selected-timeline/project snapshot whose renderer-visible closure is materialized. */
  mediaPlanSnapshot?: unknown;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

interface BlobCandidate {
  source: string;
  name: string;
}

/** Collect distinct blob media sources with a best-effort display name. */
function collectBlobCandidates(
  value: unknown,
  seen: WeakSet<object>,
  reachableSources: ReadonlySet<string>,
): Map<string, BlobCandidate> {
  const candidates = new Map<string, BlobCandidate>();
  if (value === null || typeof value !== 'object' || seen.has(value)) return candidates;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      for (const [source, candidate] of collectBlobCandidates(child, seen, reachableSources)) {
        if (!candidates.has(source)) candidates.set(source, candidate);
      }
    }
    return candidates;
  }
  let objectName: string | undefined;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'name' && typeof child === 'string' && child.trim()) objectName = child;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isMediaField(key) && isBlobSource(child) && reachableSources.has(child)) {
      if (!candidates.has(child)) {
        candidates.set(child, { source: child, name: objectName ?? '' });
      } else if (objectName && !candidates.get(child)!.name) {
        const existing = candidates.get(child)!;
        candidates.set(child, { ...existing, name: objectName });
      }
    }
  }
  for (const child of Object.values(value)) {
    if (typeof child === 'object') {
      for (const [source, candidate] of collectBlobCandidates(child, seen, reachableSources)) {
        if (!candidates.has(source)) candidates.set(source, candidate);
        else if (candidate.name && !candidates.get(source)!.name) {
          const existing = candidates.get(source)!;
          candidates.set(source, { ...existing, name: candidate.name });
        }
      }
    }
  }
  return candidates;
}

function safeUploadName(candidate: BlobCandidate, mime: string): string {
  const ext = (mime.split(';', 1)[0] || '').trim();
  const EXTENSION_BY_MIME: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm',
    'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
    'audio/webm': 'weba', 'application/octet-stream': 'bin',
  };
  const extension = EXTENSION_BY_MIME[ext] ?? 'bin';
  const base = candidate.name.trim().replace(/\.[^.]+$/, '') || 'media';
  const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return `${safe || 'media'}-blob.${extension}`;
}

/** Re-publish one blob source to /media/uploads and return its server path. */
async function publishBlobSource(
  candidate: BlobCandidate,
  options: MaterializeBlobMediaOptions,
): Promise<string> {
  const { fetcher = fetch } = options;
  const blobResponse = await fetcher(candidate.source, {
    cache: 'no-store',
    signal: options.signal,
  });
  if (!blobResponse.ok) {
    throw new Error(`blob fetch failed (HTTP ${blobResponse.status})`);
  }
  const blob = await blobResponse.blob();
  const name = safeUploadName(candidate, blob.type);
  const upload = await fetcher(`/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: blob.type ? { 'content-type': blob.type } : undefined,
    body: blob,
    signal: options.signal,
  });
  const info = (await upload.json().catch(() => null)) as { path?: string; error?: string } | null;
  if (!upload.ok || !info?.path) {
    throw new Error(info?.error ?? `upload failed (HTTP ${upload.status})`);
  }
  return info.path;
}

/** Deep-clone `value`, replacing every blob media source via `resolve` (or keep on null). */
function replaceBlobSources<T>(value: T, resolve: (source: string) => string | null): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const replaced = replaceBlobSources(entry, resolve);
      if (replaced !== entry) changed = true;
      return replaced;
    });
    return (changed ? next : value) as T;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isMediaField(key) && isBlobSource(child)) {
      const replacement = resolve(child);
      if (replacement) {
        next[key] = replacement;
        changed = true;
        continue;
      }
    }
    const replaced = replaceBlobSources(child, resolve);
    if (replaced !== child) changed = true;
    next[key] = replaced;
  }
  return (changed ? next : value) as T;
}

/**
 * Re-publish every reachable blob media source to /media/uploads and return a
 * renderable snapshot. The result is all-or-nothing: if even one reachable
 * source cannot be recovered, this rejects with the actionable export
 * preflight failure and no caller may submit a partial snapshot.
 */
export async function materializeBlobMedia<T extends object>(
  snapshot: T,
  options: MaterializeBlobMediaOptions = {},
): Promise<T> {
  const plan = collectExportMediaPlan(options.mediaPlanSnapshot ?? snapshot);
  const reachableSources = new Set(
    plan.references.map((reference) => reference.source).filter(isBlobSource),
  );
  const candidates = collectBlobCandidates(snapshot, new WeakSet(), reachableSources);
  if (candidates.size === 0) return snapshot;

  const failed: MaterializeFailure[] = [];
  const published = new Map<string, string>();
  for (const candidate of candidates.values()) {
    try {
      published.set(candidate.source, await publishBlobSource(candidate, options));
    } catch (error) {
      failed.push({
        source: candidate.source,
        name: candidate.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed.length > 0) {
    const detail = failed
      .map((item) => `${item.name ? `${item.name} (${item.source})` : item.source}: ${item.message}`)
      .join('、');
    throw new ExportFailureError(createExportFailure({
      stage: 'preflight',
      code: 'export_media_not_ready',
      retryable: false,
      message: t('导出素材未就绪：{n} 个素材仍是未完成的上传占位（可能因磁盘满或断网上传失败），请删除或重新导入这些素材：{list}', {
        n: failed.length,
        list: detail,
      }),
    }));
  }
  return replaceBlobSources(snapshot, (source) => published.get(source) ?? null);
}

export interface MaterializedTimelineExport {
  state: Timeline;
  project: ProjectDoc;
  timelineId: string;
}

/**
 * Freeze the selected project snapshot before the first asynchronous upload,
 * materialize only its renderer-reachable timeline graph, then derive the
 * submitted root state from that same materialized project.
 */
export async function materializeTimelineExport(
  project: ProjectDoc,
  timelineId: string,
  options: Omit<MaterializeBlobMediaOptions, 'mediaPlanSnapshot'> = {},
): Promise<MaterializedTimelineExport> {
  const selected = project.timelines.find((timeline) => timeline.id === timelineId);
  if (!selected) throw new Error(`timeline not found: ${timelineId}`);
  const snapshot = immutableExportSnapshot({
    ...project,
    activeTimelineId: timelineId,
  });
  const materialized = await materializeBlobMedia(snapshot, {
    ...options,
    mediaPlanSnapshot: snapshot,
  });
  const state = materialized.timelines.find((timeline) => timeline.id === timelineId);
  if (!state) throw new Error(`timeline not found: ${timelineId}`);
  return { state, project: materialized, timelineId };
}
