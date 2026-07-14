import type { MediaAsset, MediaAssetKind } from '../editor/types';

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

async function uploadFile(file: File): Promise<string> {
  const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    const info = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(info?.error ?? `上传失败 (${res.status})`);
  }
  return (await res.json() as { path: string }).path;
}

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `a_${Date.now()}`;

/** Probe → upload a media file → return a MediaAsset for the pool. */
export async function importMedia(file: File, fps: number): Promise<MediaAsset> {
  const kind = kindOf(file);
  if (!kind) throw new Error('不支持的文件类型（视频 / 图片 / 音频 / GIF / SVG）');
  const meta = await probe(file, kind, fps);
  const src = await uploadFile(file);
  return {
    id: newId(),
    name: file.name,
    kind: kind as MediaAssetKind,
    src,
    durationInFrames: meta.durationInFrames,
    width: meta.width,
    height: meta.height,
  };
}
