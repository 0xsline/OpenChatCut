import type { MediaAsset } from '../editor/types';

export type MediaKind = 'video' | 'image' | 'audio';
const IMAGE_SECONDS = 5; // stills get a default on-screen duration

export function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

// Probe duration + native dimensions in the browser before uploading, so the
// timeline item gets a correct length and aspect immediately.
function probe(file: File, kind: MediaKind, fps: number): Promise<{ durationInFrames: number; width?: number; height?: number }> {
  const fallback = { durationInFrames: Math.round(IMAGE_SECONDS * fps) };
  if (kind === 'image') {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve({ durationInFrames: Math.round(IMAGE_SECONDS * fps), width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(fallback); };
      img.src = url;
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
  if (!kind) throw new Error('不支持的文件类型（仅视频 / 图片 / 音频）');
  const meta = await probe(file, kind, fps);
  const src = await uploadFile(file);
  return { id: newId(), name: file.name, kind, src, durationInFrames: meta.durationInFrames, width: meta.width, height: meta.height };
}
