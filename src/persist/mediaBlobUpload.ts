import { MAX_TOTAL_CACHE_BYTES, type MediaBlobRecord } from './mediaBlobDatabase';

const MEDIA_AUTHORITY_HEADER = 'x-openchatcut-media-authority';

export async function serverPathIsAuthoritative(src: string): Promise<boolean> {
  try {
    const response = await fetch(src, { method: 'HEAD', cache: 'no-store' });
    return response.ok && response.headers.get(MEDIA_AUTHORITY_HEADER) === 'server';
  } catch {
    return false;
  }
}

export async function sha256Blob(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持安全的媒体哈希');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function mediaExtension(name: string): string {
  const baseName = name.slice(name.lastIndexOf('/') + 1);
  const dotIndex = baseName.lastIndexOf('.');
  const normalized = dotIndex > 0 ? baseName.slice(dotIndex).toLowerCase() : '';
  return /^\.[a-z0-9]{1,16}$/.test(normalized) ? normalized : '.bin';
}

export async function serverMediaHash(src: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(src, { cache: 'no-store' });
  } catch {
    throw new Error(`无法确认媒体目标是否已存在: ${src}`);
  }
  if (response.status === 404
    || (isSpaFallback(response) && response.headers.get(MEDIA_AUTHORITY_HEADER) !== 'server')) return null;
  if (!response.ok) throw new Error(`无法确认媒体目标是否已存在 (${response.status}): ${src}`);
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TOTAL_CACHE_BYTES) {
    throw new Error(`现有媒体目标大小无效: ${src}`);
  }
  const blob = await response.blob();
  if (blob.size <= 0 || blob.size > MAX_TOTAL_CACHE_BYTES) {
    throw new Error(`现有媒体目标大小无效: ${src}`);
  }
  return sha256Blob(blob);
}

/** Vite dev's history fallback will return 200 + index.html for any missing paths - for media paths,
 * The "successful" response of text/html is equal to the file not existing (2026-07-17 e2e disk deletion actual measurement captured: false 200
 * By cheating detection, self-healing will never be triggered). */
export const isSpaFallback = (res: Response): boolean =>
  (res.headers.get('content-type') ?? '').includes('text/html');

/** Parse `/media/uploads/<id>.ext` → assetId (filename stem) for deterministic re-upload. */
export function uploadAssetIdFromSrc(src: string): string | null {
  const m = src.match(/\/media\/uploads\/([^/]+?)(\.[A-Za-z0-9]+)?$/);
  if (!m) return null;
  return m[1].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || null;
}

export function uploadPathForRecord(rec: MediaBlobRecord): string {
  const assetId = uploadAssetIdFromSrc(rec.src);
  if (!assetId) throw new Error(`工程包媒体 src 无法生成 server 路径: ${rec.src}`);
  return `/media/uploads/${assetId}${mediaExtension(rec.name)}`;
}

interface MediaBlobUploadResult {
  path: string;
  created: boolean;
  rollbackToken?: string;
}

export async function uploadMediaBlob(
  rec: MediaBlobRecord,
  options?: { ifAbsent?: boolean; rollbackToken?: string },
): Promise<MediaBlobUploadResult> {
  const assetId = uploadAssetIdFromSrc(rec.src);
  const uploadName = options?.ifAbsent ? `file${mediaExtension(rec.name)}` : rec.name || 'file';
  const q = new URLSearchParams({ name: uploadName });
  if (assetId) q.set('assetId', assetId);
  if (options?.ifAbsent) q.set('ifAbsent', '1');
  if (options?.rollbackToken) q.set('rollbackToken', options.rollbackToken);
  const res = await fetch(`/upload?${q.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': rec.mime || 'application/octet-stream' },
    body: rec.blob,
  });
  if (!res.ok) {
    const info = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(info?.error ?? `reupload failed (${res.status})`);
  }
  const result = await res.json() as { path: string; created?: boolean; rollbackToken?: string };
  return { path: result.path, created: result.created !== false, rollbackToken: result.rollbackToken };
}
