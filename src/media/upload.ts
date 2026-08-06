import type { MediaAsset, MediaAssetKind } from '../editor/types';
import { t } from '../i18n/locale';
import { putMediaBlob } from '../persist/mediaBlobStore';
import { extractAudioForAsr } from '../transcript/provider';
import { extractAsrFromFile } from '../transcript/client-asr-extract';
import { kindOf, probeMediaFile, type MediaKind } from './mediaProbe';
import { createMediaSourceRevision } from '../editor/mediaSourceRevision';

export { kindOf } from './mediaProbe';
export type { MediaKind } from './mediaProbe';

export type UploadProgress = (ratio: number) => void;

export interface ImportMediaHooks {
  onProgress?: UploadProgress;
  /**
   * Fired ASAP after metadata probe with a blob: URL so the pool/timeline can
   * preview while the multi-GB upload + optional normalize still runs.
   * Same asset id is reused when the server path is ready.
   */
  onPlaceholder?: (asset: MediaAsset) => void;
  /**
   * Fired as soon as master bytes hit /media/uploads — *before* video normalize.
   * Use to race-ahead extract-audio / ASR while normalize still runs.
   */
  onUploaded?: (info: {
    id: string;
    src: string;
    kind: MediaKind;
    name: string;
    sourceRevision: string;
    /** Resolves to small ASR track path when extract succeeds (video/audio). */
    asrPath: Promise<string | null>;
  }) => void;
  /** Fired once server path (post-normalize) is ready — same id as placeholder. */
  onReady?: (asset: MediaAsset) => void;
}

function hooksOf(arg?: UploadProgress | ImportMediaHooks): ImportMediaHooks {
  if (!arg) return {};
  if (typeof arg === 'function') return { onProgress: arg };
  return arg;
}

/** Files at/above this size use multipart so a single network glitch doesn't redo GBs. */
const MULTIPART_THRESHOLD = 32 * 1024 * 1024;
const MULTIPART_CONCURRENCY = 3;
const PART_RETRIES = 4;

/** Stream File to a URL (same-origin /upload or R2 presigned) with XHR progress. */
async function uploadFileSimple(
  file: File,
  onProgress?: UploadProgress,
  targetUrl?: string,
): Promise<string> {
  // Prefer R2 presigned PUT when server has R2_PRESIGN on — CORS fallback to proxy.
  let url = targetUrl;
  let expectPath: string | null = null;
  if (!url) {
    try {
      const pre = await fetch('/upload/presign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          contentType: file.type || 'application/octet-stream',
        }),
      });
      if (pre.ok) {
        const slot = (await pre.json()) as {
          mode?: string;
          uploadUrl?: string;
          proxyUploadUrl?: string;
          path?: string;
        };
        if (slot.mode === 'presign' && slot.uploadUrl) {
          try {
            await putPresigned(file, slot.uploadUrl, onProgress);
            // Pull R2 → local disk so extract-audio / Player share /media/uploads.
            if (slot.path) {
              await fetch('/upload/hydrate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: slot.path }),
              }).catch(() => null);
              return slot.path;
            }
          } catch {
            // CORS / network — fall through to same-origin proxy
            url = slot.proxyUploadUrl || `/upload?name=${encodeURIComponent(file.name)}`;
            expectPath = slot.path ?? null;
          }
        } else if (slot.uploadUrl) {
          url = slot.uploadUrl;
          expectPath = slot.path ?? null;
        }
      }
    } catch {
      /* presign endpoint missing on old server */
    }
  }
  url = url || `/upload?name=${encodeURIComponent(file.name)}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const isPresign = /^https?:\/\//i.test(url!) && !url!.includes('/upload');
    xhr.open(isPresign ? 'PUT' : 'POST', url!);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (!onProgress || !ev.lengthComputable || ev.total <= 0) return;
      onProgress(Math.min(1, ev.loaded / ev.total));
    };
    xhr.onload = () => {
      if (isPresign && xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(expectPath || `/media/uploads/${file.name}`);
        return;
      }
      let info: { path?: string; error?: string } | null = null;
      try { info = JSON.parse(xhr.responseText || '{}') as { path?: string; error?: string }; }
      catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && info?.path) {
        onProgress?.(1);
        resolve(info.path);
        return;
      }
      if (xhr.status === 413) {
        reject(new Error(info?.error ?? t('文件过大，无法上传')));
        return;
      }
      reject(new Error(info?.error ?? t('上传失败 ({status})', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('上传失败 ({status})', { status: 0 })));
    xhr.onabort = () => reject(new Error(t('上传已取消')));
    xhr.send(file);
  });
}

/** PUT bytes to a presigned R2/S3 URL. */
function putPresigned(file: File, uploadUrl: string, onProgress?: UploadProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (!onProgress || !ev.lengthComputable || ev.total <= 0) return;
      onProgress(Math.min(1, ev.loaded / ev.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      reject(new Error(t('上传失败 ({status})', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('上传失败 ({status})', { status: 0 })));
    xhr.onabort = () => reject(new Error(t('上传已取消')));
    xhr.send(file);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function putPart(uploadId: string, part: number, blob: Blob): Promise<void> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= PART_RETRIES; attempt += 1) {
    try {
      const res = await fetch(
        `/upload/multipart/part?uploadId=${encodeURIComponent(uploadId)}&part=${part}`,
        { method: 'PUT', body: blob },
      );
      if (res.ok) return;
      const info = (await res.json().catch(() => null)) as { error?: string } | null;
      lastErr = new Error(info?.error ?? `part ${part} failed (${res.status})`);
      if (res.status < 500 && res.status !== 408 && res.status !== 429) throw lastErr;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt >= PART_RETRIES) break;
      await sleep(Math.min(16_000, 500 * 2 ** (attempt - 1)));
      continue;
    }
    if (attempt < PART_RETRIES) await sleep(Math.min(16_000, 500 * 2 ** (attempt - 1)));
  }
  throw lastErr ?? new Error(`part ${part} failed`);
}

/** Multipart upload with per-part retry (local stand-in for S3 multipart). */
async function uploadFileMultipartAttempt(file: File, onProgress?: UploadProgress): Promise<string> {
  const initRes = await fetch('/upload/multipart/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
    }),
  });
  if (!initRes.ok) {
    const info = (await initRes.json().catch(() => null)) as { error?: string } | null;
    if (initRes.status === 413) throw new Error(info?.error ?? t('文件过大，无法上传'));
    throw new Error(info?.error ?? t('上传失败 ({status})', { status: initRes.status }));
  }
  const init = (await initRes.json()) as {
    uploadId: string;
    partSize: number;
    partCount: number;
  };
  const { uploadId, partSize, partCount } = init;
  const done = new Set<number>();
  const report = () => onProgress?.(Math.min(1, done.size / partCount));

  let cursor = 1;
  const workers = Array.from({ length: Math.min(MULTIPART_CONCURRENCY, partCount) }, async () => {
    while (true) {
      const part = cursor;
      cursor += 1;
      if (part > partCount) return;
      const start = (part - 1) * partSize;
      const end = Math.min(file.size, start + partSize);
      const slice = file.slice(start, end);
      try {
        await putPart(uploadId, part, slice);
        done.add(part);
        report();
      } catch (err) {
        // Abort session best-effort so disk doesn't fill with orphans
        void fetch(`/upload/multipart?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
        throw err;
      }
    }
  });
  await Promise.all(workers);

  const completeRes = await fetch('/upload/multipart/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });
  if (!completeRes.ok) {
    const info = (await completeRes.json().catch(() => null)) as { error?: string } | null;
    throw new Error(info?.error ?? t('上传失败 ({status})', { status: completeRes.status }));
  }
  const doneBody = (await completeRes.json()) as { path?: string };
  if (!doneBody.path) throw new Error(t('上传失败 ({status})', { status: completeRes.status }));
  onProgress?.(1);
  return doneBody.path;
}

export function isExpiredMultipartSessionError(error: unknown): boolean {
  return error instanceof Error && /upload session not found or expired/i.test(error.message);
}

/** Retry once with a fresh multipart session after an embedded-server restart. */
export async function retryExpiredMultipartSession<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isExpiredMultipartSessionError(error)) throw error;
  }
  try {
    return await attempt();
  } catch (error) {
    if (isExpiredMultipartSessionError(error)) throw new Error(t('上传会话已失效，请重新导入'));
    throw error;
  }
}

async function uploadFileMultipart(file: File, onProgress?: UploadProgress): Promise<string> {
  return retryExpiredMultipartSession(() => uploadFileMultipartAttempt(file, onProgress));
}

async function uploadFile(file: File, onProgress?: UploadProgress): Promise<string> {
  if (file.size >= MULTIPART_THRESHOLD) {
    try {
      return await uploadFileMultipart(file, onProgress);
    } catch (err) {
      // Fall back to single-shot stream if multipart stack is down (old server).
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|Failed to fetch|multipart/i.test(msg)) {
        return uploadFileSimple(file, onProgress);
      }
      throw err;
    }
  }
  return uploadFileSimple(file, onProgress);
}

export interface DesktopLocalMediaImport {
  src: string;
  storedName: string;
  proxyKind?: 'alpha-webm';
}

export interface DesktopLocalMediaApi {
  importLocalMedia?(file: File): Promise<DesktopLocalMediaImport | null>;
  prepareTransparentMovProxy?(storedName: string): Promise<{ src: string } | null>;
}

export interface DesktopLocalMediaTransfer {
  src: string;
  desktopImport: DesktopLocalMediaImport | null;
}

type DesktopUploadFallback = (file: File, onProgress?: UploadProgress) => Promise<string>;

async function importDesktopLocalMedia(
  file: File,
  api: DesktopLocalMediaApi | undefined,
): Promise<DesktopLocalMediaImport | null> {
  if (!api?.importLocalMedia) return null;
  const imported = await api.importLocalMedia(file);
  if (!imported) return null;
  if (!/\.mov$/i.test(imported.storedName) || !api.prepareTransparentMovProxy) return imported;
  const proxy = await api.prepareTransparentMovProxy(imported.storedName).catch(() => null);
  return proxy ? { ...imported, src: proxy.src, proxyKind: 'alpha-webm' } : imported;
}

/** Prefer the native desktop bridge; only absent/pathless bridges use HTTP. */
export async function transferDesktopLocalMedia(
  file: File,
  api: DesktopLocalMediaApi | undefined,
  uploadFallback: DesktopUploadFallback,
  onProgress?: UploadProgress,
): Promise<DesktopLocalMediaTransfer> {
  const desktopImport = await importDesktopLocalMedia(file, api);
  if (desktopImport) return { src: desktopImport.src, desktopImport };
  return { src: await uploadFallback(file, onProgress), desktopImport: null };
}

export function shouldNormalizeImportedVideo(
  kind: MediaKind,
  desktopImport: DesktopLocalMediaImport | null,
): boolean {
  return kind === 'video' && desktopImport?.proxyKind !== 'alpha-webm';
}

type ImportUploadedInfo = Parameters<NonNullable<ImportMediaHooks['onUploaded']>>[0];

export interface ImportTranscriptionStart {
  asset: Pick<MediaAsset, 'id' | 'src' | 'kind' | 'sourceRevision'> & { name?: string };
  asrPath: Promise<string | null>;
}

/**
 * New assets can start ASR from the uploaded master immediately. A replacement
 * must wait until its ready descriptor has relinked the existing master, so a
 * failed normalize cannot overwrite the old master's transcription state/job.
 */
export function createImportTranscriptionGate(relinkAssetId?: string) {
  let pending: ImportUploadedInfo | null = null;
  return {
    uploaded(info: ImportUploadedInfo): ImportTranscriptionStart | null {
      if (relinkAssetId) {
        pending = info;
        return null;
      }
      return { asset: info, asrPath: info.asrPath };
    },
    ready(asset: MediaAsset): ImportTranscriptionStart | null {
      if (!relinkAssetId || !pending) return null;
      const asrPath = pending.asrPath;
      pending = null;
      return { asset: { ...asset, id: relinkAssetId }, asrPath };
    },
  };
}

/**
 * Resolve clipboard snapshots against the live pool. A placeholder copied
 * during ingest becomes pasteable once its master is ready; until then its
 * short-lived blob URL is never persisted into a duplicate asset.
 */
export function readyMediaAssetsForPaste(
  copied: MediaAsset[],
  current: MediaAsset[],
): MediaAsset[] {
  const currentById = new Map(current.map((asset) => [asset.id, asset]));
  return copied
    .map((asset) => currentById.get(asset.id) ?? asset)
    .filter((asset) => !asset.src.startsWith('blob:'));
}

export function createMediaAssetsChatSeed(assets: MediaAsset[], nonce = Date.now()) {
  if (!assets.length) return null;
  return {
    text: `${assets.map((asset) => `@${asset.name}`).join(' ')} `,
    nonce,
    references: assets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind })),
  };
}

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `a_${Date.now()}`;

/** Post-upload conditional compress (server ffmpeg). No-op for already-efficient sources. */
export async function normalizeUploadedVideo(
  src: string,
): Promise<{ src: string; width?: number; height?: number; durationSeconds?: number; fps?: number }> {
  try {
    const res = await fetch('/api/normalize-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src }),
    });
    const data = (await res.json()) as {
      path?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
      fps?: number;
      normalized?: boolean;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.path?.startsWith('/media/uploads/')) {
      return {
        src: data.path,
        width: typeof data.width === 'number' ? data.width : undefined,
        height: typeof data.height === 'number' ? data.height : undefined,
        durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : undefined,
        fps: typeof data.fps === 'number' ? data.fps : undefined,
      };
    }
    throw new Error('server returned no media path');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(t('视频兼容性处理失败：{error}', { error: message }));
  }
}

/**
 * Probe → optional blob placeholder → upload → optional normalize → ready asset.
 * Third arg may be a progress callback (legacy) or hooks for progressive pool entry.
 */
export async function importMedia(
  file: File,
  fps: number,
  onProgressOrHooks?: UploadProgress | ImportMediaHooks,
): Promise<MediaAsset> {
  const hooks = hooksOf(onProgressOrHooks);
  const sourceFilename = file.name;
  let originalFilePath: string | undefined;
  try {
    originalFilePath = typeof window === 'undefined'
      ? undefined
      : window.openChatCutDesktop?.getPathForFile(file);
  } catch {
    // A synthetic/browser-only File has no backing path; import still works without NLE relink metadata.
    originalFilePath = undefined;
  }
  const kind = kindOf(file);
  if (!kind) throw new Error(t('不支持的文件类型（视频 / 图片 / 音频 / GIF / SVG）'));
  const meta = await probeMediaFile(file, kind, fps);
  const id = newId();
  const sourceSize = file.size;
  const sourceModifiedAt = file.lastModified;
  const sourceRevision = createMediaSourceRevision({
    src: `file:${sourceFilename}`,
    name: sourceFilename,
    kind: kind as MediaAssetKind,
    sourceSize,
    sourceModifiedAt,
    durationInFrames: meta.durationInFrames,
    width: meta.width,
    height: meta.height,
  });

  // Local preview while upload runs — blob: is marked reachable by mediaBlobStore helpers.
  const blobUrl = URL.createObjectURL(file);
  const placeholder: MediaAsset = {
    id,
    name: sourceFilename,
    sourceFilename,
    originalFilePath,
    kind: kind as MediaAssetKind,
    src: blobUrl,
    durationInFrames: meta.durationInFrames,
    sourceRevision,
    sourceSize,
    sourceModifiedAt,
    width: meta.width,
    height: meta.height,
  };
  try {
    hooks.onPlaceholder?.(placeholder);

    // Start client ASR extraction from the local file in parallel
    // with master upload (before master bytes finish). Falls back to server
    // extract-audio once master lands if the client path fails.
    const clientAsr = (kind === 'video' || kind === 'audio')
      ? extractAsrFromFile(file, kind).catch(() => null)
      : Promise.resolve(null);

    // Upload fills 0..0.9; optional video normalize uses 0.9..1.
    const { desktopImport, src: srcRaw } = await transferDesktopLocalMedia(
      file,
      (globalThis as typeof globalThis & { openChatCutDesktop?: DesktopLocalMediaApi }).openChatCutDesktop,
      uploadFile,
      hooks.onProgress ? (ratio) => hooks.onProgress!(ratio * 0.9) : undefined,
    );
    hooks.onProgress?.(0.92);

    // First successful path wins: client race (started pre-upload) vs server extract.
    const asrPath = (kind === 'video' || kind === 'audio')
      ? Promise.any([
        clientAsr.then((p) => { if (!p) throw new Error('client-asr-miss'); return p; }),
        extractAudioForAsr(srcRaw).then((p) => { if (!p) throw new Error('server-asr-miss'); return p; }),
      ]).catch(() => null)
      : Promise.resolve(null);
    hooks.onUploaded?.({ id, src: srcRaw, kind, name: sourceFilename, sourceRevision, asrPath });

    let src = srcRaw;
    let width = meta.width;
    let height = meta.height;
    let durationInFrames = meta.durationInFrames;
    if (shouldNormalizeImportedVideo(kind, desktopImport)) {
      const norm = await normalizeUploadedVideo(srcRaw);
      src = norm.src;
      if (norm.width) width = norm.width;
      if (norm.height) height = norm.height;
      if (norm.durationSeconds && norm.durationSeconds > 0) {
        durationInFrames = Math.max(1, Math.round(norm.durationSeconds * fps));
      }
    }
    hooks.onProgress?.(1);

    if (src === srcRaw && !desktopImport) {
      void putMediaBlob(src, file, {
        name: sourceFilename,
        mime: file.type,
        sourceRevision,
        sourceSize,
        sourceModifiedAt,
      });
    }

    const ready: MediaAsset = {
      id,
      name: sourceFilename,
      sourceFilename,
      originalFilePath,
      kind: kind as MediaAssetKind,
      src,
      durationInFrames,
      sourceRevision,
      sourceSize,
      sourceModifiedAt,
      width,
      height,
    };
    // Stash race promise so callers of the return value can await ASR without re-extract.
    (ready as MediaAsset & { __asrPath?: Promise<string | null> }).__asrPath = asrPath;
    hooks.onReady?.(ready);
    return ready;
  } finally {
    // Drop blob after swap (or failure). Timeline/pool should already hold server src
    // via onReady → relink; revoking too early races the player — delay a tick.
    const toRevoke = blobUrl;
    setTimeout(() => URL.revokeObjectURL(toRevoke), 30_000);
  }
}

/** Cache + optional re-publish helpers for callers that already have a public src. */
export { putMediaBlob, ensureMediaSrcs } from '../persist/mediaBlobStore';
