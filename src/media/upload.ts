import type { MediaAsset, MediaAssetKind } from '../editor/types';
import { t } from '../i18n/locale';
import { putMediaBlob } from '../persist/mediaBlobStore';
import { extractAudioForAsr } from '../transcript/assemblyai';
import { extractAsrFromFile } from '../transcript/client-asr-extract';

export type MediaKind = 'video' | 'image' | 'audio' | 'gif' | 'svg';
const IMAGE_SECONDS = 5; // stills / svg get a default on-screen duration
const GIF_SECONDS_FALLBACK = 5;

export function kindOf(file: File): MediaKind | null {
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (type === 'image/gif' || name.endsWith('.gif')) return 'gif';
  if (type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  return null;
}

// Probe duration + native dimensions in the browser before uploading, so the
// timeline item gets a correct length and aspect immediately.
function probe(file: File, kind: MediaKind, fps: number): Promise<{ durationInFrames: number; width?: number; height?: number }> {
  const stillFrames = Math.round(IMAGE_SECONDS * fps);
  const fallback = { durationInFrames: stillFrames };
  if (kind === 'image' || kind === 'svg') {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ durationInFrames: stillFrames, width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(fallback); };
      img.src = url;
    });
  }
  if (kind === 'gif') {
    // Prefer video element for duration; fall back to image size + default length.
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.preload = 'metadata';
      const done = (meta: { durationInFrames: number; width?: number; height?: number }) => {
        URL.revokeObjectURL(url);
        resolve(meta);
      };
      vid.onloadedmetadata = () => {
        const dur = Number.isFinite(vid.duration) && vid.duration > 0
          ? Math.max(1, Math.round(vid.duration * fps))
          : Math.round(GIF_SECONDS_FALLBACK * fps);
        done({ durationInFrames: dur, width: vid.videoWidth || undefined, height: vid.videoHeight || undefined });
      };
      vid.onerror = () => {
        const img = new Image();
        img.onload = () => done({
          durationInFrames: Math.round(GIF_SECONDS_FALLBACK * fps),
          width: img.naturalWidth || undefined,
          height: img.naturalHeight || undefined,
        });
        img.onerror = () => done(fallback);
        img.src = url;
      };
      vid.src = url;
    });
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === 'video' ? 'video' : 'audio') as HTMLVideoElement;
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const durationInFrames = Math.max(1, Math.round((el.duration || IMAGE_SECONDS) * fps));
      URL.revokeObjectURL(url);
      resolve({ durationInFrames, width: kind === 'video' ? el.videoWidth : undefined, height: kind === 'video' ? el.videoHeight : undefined });
    };
    el.onerror = () => { URL.revokeObjectURL(url); resolve(fallback); };
    el.src = url;
  });
}

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
    assetId: string;
    src: string;
    kind: MediaKind;
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
async function uploadFileMultipart(file: File, onProgress?: UploadProgress): Promise<string> {
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

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `a_${Date.now()}`;

/** Post-upload conditional compress (server ffmpeg). No-op for already-efficient sources. */
async function normalizeUploadedVideo(
  src: string,
): Promise<{ src: string; width?: number; height?: number }> {
  try {
    const res = await fetch('/api/normalize-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src }),
    });
    if (!res.ok) return { src };
    const data = (await res.json()) as {
      path?: string;
      width?: number;
      height?: number;
      normalized?: boolean;
    };
    if (data.path?.startsWith('/media/uploads/')) {
      return {
        src: data.path,
        width: typeof data.width === 'number' ? data.width : undefined,
        height: typeof data.height === 'number' ? data.height : undefined,
      };
    }
  } catch {
    /* keep original — normalize is best-effort */
  }
  return { src };
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
  const kind = kindOf(file);
  if (!kind) throw new Error(t('不支持的文件类型（视频 / 图片 / 音频 / GIF / SVG）'));
  const meta = await probe(file, kind, fps);
  const id = newId();

  // Local preview while upload runs — blob: is marked reachable by mediaBlobStore helpers.
  const blobUrl = URL.createObjectURL(file);
  const placeholder: MediaAsset = {
    id,
    name: file.name,
    kind: kind as MediaAssetKind,
    src: blobUrl,
    durationInFrames: meta.durationInFrames,
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
    const srcRaw = await uploadFile(file, hooks.onProgress
      ? (r) => hooks.onProgress!(r * 0.9)
      : undefined);
    hooks.onProgress?.(0.92);

    // First successful path wins: client race (started pre-upload) vs server extract.
    const asrPath = (kind === 'video' || kind === 'audio')
      ? Promise.any([
        clientAsr.then((p) => { if (!p) throw new Error('client-asr-miss'); return p; }),
        extractAudioForAsr(srcRaw).then((p) => { if (!p) throw new Error('server-asr-miss'); return p; }),
      ]).catch(() => null)
      : Promise.resolve(null);
    hooks.onUploaded?.({ assetId: id, src: srcRaw, kind, asrPath });

    let src = srcRaw;
    let width = meta.width;
    let height = meta.height;
    if (kind === 'video') {
      const norm = await normalizeUploadedVideo(srcRaw);
      src = norm.src;
      if (norm.width) width = norm.width;
      if (norm.height) height = norm.height;
    }
    hooks.onProgress?.(1);

    if (src === srcRaw) {
      void putMediaBlob(src, file, { name: file.name, mime: file.type });
    }

    const ready: MediaAsset = {
      id,
      name: file.name,
      kind: kind as MediaAssetKind,
      src,
      durationInFrames: meta.durationInFrames,
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
