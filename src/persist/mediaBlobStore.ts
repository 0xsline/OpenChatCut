import {
  MAX_FILE_CACHE_BYTES, MAX_TOTAL_CACHE_BYTES, idbMetadata, enqueueSourceWrite, enqueueCapacityWrite,
  idbPut, idbGet, idbDel, idbDelPrefix,
  type MediaBlobRecord, type MediaBlobWriteMeta,
} from './mediaBlobDatabase';
import {
  serverPathIsAuthoritative, sha256Blob, mediaExtension, serverMediaHash,
  isSpaFallback, uploadPathForRecord, uploadMediaBlob,
} from './mediaBlobUpload';
export { resetMediaBlobMemory } from './mediaBlobDatabase';
export type { MediaBlobRecord, MediaBlobWriteMeta } from './mediaBlobDatabase';
export { uploadAssetIdFromSrc } from './mediaBlobUpload';

const MEDIA_IMPORT_PREFIX = 'openchatcut-media-import:';
let mediaImportCounter = 0;
export interface StagedMediaBlobImportEntry {
  /** Safe destination allocated from the decoded bytes, never from the package src. */
  src: string;
  tempSrc: string;
  sha256: string;
}

export interface PublishedMediaBlobImportEntry extends StagedMediaBlobImportEntry {
  created: boolean;
}
export interface CreatedServerMediaPublication {
  src: string;
  rollbackToken: string;
}

export interface MediaBlobImportPublication {
  namespace: string;
  entries: readonly PublishedMediaBlobImportEntry[];
  createdServerMedia: readonly CreatedServerMediaPublication[];
}

/** Cache a source blob when no authoritative local server copy is advertised. */
export async function putMediaBlob(
  src: string,
  data: Blob | File,
  meta?: MediaBlobWriteMeta,
): Promise<void> {
  if (!src.startsWith('/media/uploads/')) return;
  const bytes = data.size;
  if (bytes <= 0 || bytes > MAX_FILE_CACHE_BYTES) return;
  await enqueueSourceWrite(src, async () => {
    if (await serverPathIsAuthoritative(src)) return;
    await enqueueCapacityWrite(async () => {
      if (meta?.sourceRevision && meta.isSourceRevisionCurrent
        && !meta.isSourceRevisionCurrent(meta.sourceRevision)) return;
      const previous = await idbGet(src);
      const existing = await idbMetadata();
      if (existing.reduce((total, record) => total + record.bytes, 0)
        - (existing.find((record) => record.src === src)?.bytes ?? 0) + bytes > MAX_TOTAL_CACHE_BYTES) return;
      const isFile = typeof File !== 'undefined' && data instanceof File;
      const timestamp = Date.now();
      if (meta?.sourceRevision && meta.isSourceRevisionCurrent
        && !meta.isSourceRevisionCurrent(meta.sourceRevision)) return;
      await idbPut({
        src,
        blob: data,
        name: meta?.name ?? (isFile ? (data as File).name : src.split('/').pop() ?? 'file'),
        mime: meta?.mime || data.type || 'application/octet-stream',
        ...(meta?.sourceRevision ? { sourceRevision: meta.sourceRevision } : {}),
        ...(typeof meta?.sourceSize === 'number' ? { sourceSize: meta.sourceSize } : {}),
        ...(typeof meta?.sourceModifiedAt === 'number' ? { sourceModifiedAt: meta.sourceModifiedAt } : {}),
        bytes,
        savedAt: timestamp,
        lastAccessedAt: timestamp,
      });
      if (meta?.sourceRevision && meta.isSourceRevisionCurrent
        && !meta.isSourceRevisionCurrent(meta.sourceRevision)) {
        if (previous) await idbPut(previous);
        else await idbDel(src);
      }
    });
  }).catch(() => {
    /* quota / private mode — an existing source is never evicted */
  });
}

export async function getMediaBlob(src: string): Promise<MediaBlobRecord | undefined> {
  try {
    return await enqueueSourceWrite(src, async () => {
      const record = await idbGet(src);
      if (!record) return undefined;
      const touched = { ...record, bytes: record.blob.size, lastAccessedAt: Date.now() };
      await idbPut(touched);
      return touched;
    });
  } catch {
    return undefined;
  }
}

export async function deleteMediaBlob(src: string): Promise<void> {
  await enqueueSourceWrite(src, () => idbDel(src)).catch(() => {
    /* best effort; server deletion remains authoritative */
  });
}
function assertMediaImportNamespace(namespace: string): void {
  if (!namespace.startsWith(MEDIA_IMPORT_PREFIX) || !namespace.endsWith('/')) {
    throw new Error('媒体导入临时命名空间无效');
  }
}

function mediaImportKey(namespace: string, src: string): string {
  assertMediaImportNamespace(namespace);
  return `${namespace}staged/${encodeURIComponent(src)}`;
}

async function mediaIdentityState(src: string, sha256: string): Promise<'absent' | 'matching' | 'conflict'> {
  let found = false;
  const cached = await idbGet(src);
  if (cached) {
    found = true;
    if (await sha256Blob(cached.blob) !== sha256) return 'conflict';
  }
  const serverHash = await serverMediaHash(src);
  if (serverHash !== null) {
    found = true;
    if (serverHash !== sha256) return 'conflict';
  }
  return found ? 'matching' : 'absent';
}

async function allocateImportedMediaSrc(
  namespace: string,
  sha256: string,
  name: string,
): Promise<string> {
  const extension = mediaExtension(name);
  const contentAddressed = `/media/uploads/sha256-${sha256}${extension}`;
  if (await mediaIdentityState(contentAddressed, sha256) !== 'conflict') return contentAddressed;

  const importId = namespace.slice(MEDIA_IMPORT_PREFIX.length, -1)
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, 36);
  for (let index = 0; index < 16; index += 1) {
    const candidate = `/media/uploads/import-${importId}-${index.toString(36)}-${sha256.slice(0, 24)}${extension}`;
    if (await mediaIdentityState(candidate, sha256) !== 'conflict') return candidate;
  }
  throw new Error('无法分配隔离的工程包媒体名称');
}

/** Allocate an opaque namespace whose records cannot collide with real media src keys. */
export function createMediaBlobImportNamespace(): string {
  mediaImportCounter += 1;
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${mediaImportCounter.toString(36)}`;
  return `${MEDIA_IMPORT_PREFIX}${randomId}/`;
}

/**
 * Persist one decoded package entry under its import namespace. The untrusted
 * package src is validated but never used as a global key: decoded bytes select
 * a content-addressed destination, with an import-scoped fallback on conflict.
 */
export async function stageMediaBlobImport(
  namespace: string,
  packageSrc: string,
  data: Blob | File,
  meta?: MediaBlobWriteMeta,
): Promise<StagedMediaBlobImportEntry> {
  assertMediaImportNamespace(namespace);
  if (!packageSrc.startsWith('/media/uploads/')) throw new Error('工程包媒体 src 无效');
  const bytes = data.size;
  if (bytes <= 0 || bytes > MAX_TOTAL_CACHE_BYTES) throw new Error('工程包媒体大小无效');
  const sha256 = await sha256Blob(data);
  const name = meta?.name ?? (
    typeof File !== 'undefined' && data instanceof File
      ? data.name
      : packageSrc.split('/').pop() ?? 'file'
  );
  const src = await allocateImportedMediaSrc(namespace, sha256, name);
  const tempSrc = mediaImportKey(namespace, src);
  await enqueueSourceWrite(tempSrc, () => enqueueCapacityWrite(async () => {
    const existing = await idbMetadata();
    const previousBytes = existing.find((record) => record.src === tempSrc)?.bytes ?? 0;
    if (existing.reduce((total, record) => total + record.bytes, 0) - previousBytes + bytes
      > MAX_TOTAL_CACHE_BYTES) {
      throw new Error('工程包媒体临时存储空间不足');
    }
    const timestamp = Date.now();
    await idbPut({
      src: tempSrc,
      blob: data,
      name,
      mime: meta?.mime || data.type || 'application/octet-stream',
      ...(meta?.sourceRevision ? { sourceRevision: meta.sourceRevision } : {}),
      ...(typeof meta?.sourceSize === 'number' ? { sourceSize: meta.sourceSize } : {}),
      ...(typeof meta?.sourceModifiedAt === 'number' ? { sourceModifiedAt: meta.sourceModifiedAt } : {}),
      bytes,
      savedAt: timestamp,
      lastAccessedAt: timestamp,
    });
  }));
  return { src, tempSrc, sha256 };
}

/** Remove every staged record owned by one import. */
export async function discardMediaBlobImport(namespace: string): Promise<void> {
  assertMediaImportNamespace(namespace);
  await enqueueCapacityWrite(() => idbDelPrefix(namespace));
}

async function rollbackPublishedMedia(
  entries: readonly PublishedMediaBlobImportEntry[],
  publicationId: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    try {
      await enqueueSourceWrite(entry.src, async () => {
        const current = await idbGet(entry.src);
        if (current?.importPublicationId !== publicationId || !entry.created) return;
        await idbDel(entry.src);
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '工程包媒体真实键回滚未完整完成');
}

async function clearPublishedMediaIdentity(publication: MediaBlobImportPublication): Promise<void> {
  const failures: unknown[] = [];
  for (const entry of publication.entries) {
    try {
      await enqueueSourceWrite(entry.src, async () => {
        const current = await idbGet(entry.src);
        if (current?.importPublicationId !== publication.namespace) return;
        const committed = { ...current };
        delete committed.importPublicationId;
        await idbPut(committed);
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, '工程包媒体发布标识清理未完整完成');
}
async function deleteImportedServerMedia(created: CreatedServerMediaPublication): Promise<void> {
  if (!created.src.startsWith('/media/uploads/')) {
    throw new Error(`工程包 server 媒体路径无效: ${created.src}`);
  }
  const name = created.src.slice('/media/uploads/'.length);
  const query = new URLSearchParams({ name, rollbackToken: created.rollbackToken });
  const response = await fetch(`/upload?${query.toString()}`, {
    method: 'DELETE',
  });
  if (response.ok) return;
  const info = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(info?.error ?? `server media rollback failed (${response.status}): ${created.src}`);
}

/** Finalize a successful import by clearing CAS identities and temporary records. */
export async function commitMediaBlobImport(publication: MediaBlobImportPublication): Promise<void> {
  const failures: unknown[] = [];
  try {
    await clearPublishedMediaIdentity(publication);
  } catch (error) {
    failures.push(error);
  }
  try {
    await discardMediaBlobImport(publication.namespace);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, '工程包媒体提交清理未完整完成');
}

/** CAS-delete import-owned keys, conditionally delete import-owned server media, and remove temporary records. */
export async function rollbackMediaBlobImport(publication: MediaBlobImportPublication): Promise<void> {
  const failures: unknown[] = [];
  try {
    await rollbackPublishedMedia(publication.entries, publication.namespace);
  } catch (error) {
    failures.push(error);
  }
  for (let index = publication.createdServerMedia.length - 1; index >= 0; index -= 1) {
    try {
      await deleteImportedServerMedia(publication.createdServerMedia[index]!);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await discardMediaBlobImport(publication.namespace);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, '工程包媒体回滚或清理未完整完成');
}

/**
 * Newly allocated global records carry an import ownership marker until the
 * caller either commits after project publication or removes them on rollback.
 * Hash-matching records are reused without modifying their identity or metadata.
 */
export async function publishMediaBlobImport(
  namespace: string,
  entries: readonly StagedMediaBlobImportEntry[],
): Promise<MediaBlobImportPublication> {
  assertMediaImportNamespace(namespace);
  const published: PublishedMediaBlobImportEntry[] = [];
  const createdServerMedia: CreatedServerMediaPublication[] = [];
  const seen = new Set<string>();
  try {
    for (const entry of entries) {
      if (seen.has(entry.src) || entry.tempSrc !== mediaImportKey(namespace, entry.src)) {
        throw new Error(`工程包媒体发布清单无效: ${entry.src}`);
      }
      seen.add(entry.src);
      const staged = await enqueueSourceWrite(entry.tempSrc, () => idbGet(entry.tempSrc));
      if (!staged) throw new Error(`工程包媒体临时条目缺失: ${entry.src}`);
      const created = await enqueueSourceWrite(entry.src, async () => {
        const previous = await idbGet(entry.src);
        if (previous) {
          if (await sha256Blob(previous.blob) !== entry.sha256) {
            throw new Error(`工程包媒体目标已被不同内容占用: ${entry.src}`);
          }
          return false;
        }
        const timestamp = Date.now();
        await idbPut({
          ...staged,
          src: entry.src,
          bytes: staged.blob.size,
          savedAt: timestamp,
          lastAccessedAt: timestamp,
          importPublicationId: namespace,
        });
        return true;
      });
      published.push({ ...entry, created });
      if (await sha256Blob(staged.blob) !== entry.sha256) {
        throw new Error(`工程包媒体临时条目哈希不匹配: ${entry.src}`);
      }
      const record = { ...staged, src: entry.src };
      const existingServerHash = await serverMediaHash(entry.src);
      if (existingServerHash !== null) {
        if (existingServerHash !== entry.sha256) {
          throw new Error(`工程包 server 媒体目标已被不同内容占用: ${entry.src}`);
        }
        continue;
      }
      const rollbackToken = createMediaRollbackToken();
      const candidate = { src: uploadPathForRecord(record), rollbackToken };
      createdServerMedia.push(candidate);
      const uploaded = await uploadMediaBlob(record, { ifAbsent: true, rollbackToken });
      candidate.src = uploaded.path;
      if (!uploaded.created) {
        createdServerMedia.pop();
        if (await serverMediaHash(uploaded.path) !== entry.sha256) {
          throw new Error(`工程包 server 媒体目标竞争冲突: ${uploaded.path}`);
        }
      }
      if (uploaded.created && uploaded.rollbackToken !== rollbackToken) {
        throw new Error(`工程包 server 媒体 rollback token 不匹配: ${uploaded.path}`);
      }
      if (uploaded.path !== entry.src) {
        throw new Error(`工程包媒体未按安全 src 发布: ${entry.src}`);
      }
    }
    return { namespace, entries: published, createdServerMedia };
  } catch (error) {
    try {
      await rollbackMediaBlobImport({ namespace, entries: published, createdServerMedia });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '工程包媒体发布失败，回滚或清理未完整完成');
    }
    throw error;
  }
}
export interface MediaBlobStoreUsage {
  bytes: number;
  records: number;
  maxBytes: number;
  lru: Array<{ src: string; bytes: number; lastAccessedAt: number }>;
}

export async function mediaBlobStoreUsage(): Promise<MediaBlobStoreUsage> {
  const lru = (await idbMetadata().catch(() => []))
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  return {
    bytes: lru.reduce((total, record) => total + record.bytes, 0),
    records: lru.length,
    maxBytes: MAX_TOTAL_CACHE_BYTES,
    lru,
  };
}

/** True when the same-origin path responds OK (file present on dev disk). */
export async function isMediaSrcReachable(src: string): Promise<boolean> {
  if (!src || src.startsWith('data:')) return true;
  if (src.startsWith('blob:')) {
    // blob: HEAD is prohibited by the specification, and can only be verified through GET. Live blob (placeholder in this session's upload) = reachable;
    // The blob that reopens the page after persistence will die (it will become invalid upon refreshing) → fetch throws an error = true loss.
    try {
      const res = await fetch(src);
      void res.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }
  if (!src.startsWith('/')) return true; // remote URL — not our job
  try {
    const res = await fetch(src, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
    const reachable = (res.ok || res.status === 206) && !isSpaFallback(res);
    void res.body?.cancel();
    return reachable;
  } catch {
    return false;
  }
}

function createMediaRollbackToken(): string {
  mediaImportCounter += 1;
  return globalThis.crypto?.randomUUID?.()
    ?? `import-${Date.now().toString(36)}-${mediaImportCounter.toString(36)}`;
}

/**
 * Re-publish a cached blob to the same /media/uploads path (or best-effort same
 * name). Returns the path from the server (usually unchanged).
 */
export async function reuploadMediaBlob(rec: MediaBlobRecord): Promise<string> {
  const { path } = await uploadMediaBlob(rec);
  // If server minted a new name, re-key the cache.
  if (path !== rec.src) {
    await putMediaBlob(path, rec.blob, {
      name: rec.name,
      mime: rec.mime,
      sourceRevision: rec.sourceRevision,
      sourceSize: rec.sourceSize,
      sourceModifiedAt: rec.sourceModifiedAt,
    });
    await deleteMediaBlob(rec.src);
  }
  return path;
}

export interface EnsureMediaResult {
  ok: string[];
  restored: string[];
  missing: string[];
}

/**
 * For each /media/uploads src: if disk is missing but IDB has the blob, re-upload.
 * Non-upload srcs are skipped. Best-effort; never throws.
 */
export async function ensureMediaSrcs(srcs: string[]): Promise<EnsureMediaResult> {
  const result: EnsureMediaResult = { ok: [], restored: [], missing: [] };
  const unique = [...new Set(srcs.filter((s) => typeof s === 'string' && s.startsWith('/media/uploads/')))];
  for (const src of unique) {
    try {
      if (await isMediaSrcReachable(src)) {
        result.ok.push(src);
        continue;
      }
      const rec = await getMediaBlob(src);
      if (!rec) {
        result.missing.push(src);
        continue;
      }
      const path = await reuploadMediaBlob(rec);
      result.restored.push(path);
    } catch {
      result.missing.push(src);
    }
  }
  return result;
}
