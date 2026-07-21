export type MediaKind = 'video' | 'image' | 'audio' | 'gif' | 'svg';

export interface MediaMetadata {
  durationInFrames: number;
  width?: number;
  height?: number;
}

const IMAGE_SECONDS = 5;
const GIF_SECONDS_FALLBACK = 5;
const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac'];

export function kindOfDescriptor(rawName: string, rawType = ''): MediaKind | null {
  const name = rawName.toLowerCase();
  const type = rawType.toLowerCase();
  if (type === 'image/gif' || name.endsWith('.gif')) return 'gif';
  if (type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'video';
  if (IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'image';
  if (AUDIO_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'audio';
  return null;
}

export function kindOf(file: File): MediaKind | null {
  return kindOfDescriptor(file.name, file.type);
}

function probeStill(url: string, frames: number, release: () => void): Promise<MediaMetadata> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      release();
      resolve({ durationInFrames: frames, width: image.naturalWidth || undefined, height: image.naturalHeight || undefined });
    };
    image.onerror = () => { release(); resolve({ durationInFrames: frames }); };
    image.src = url;
  });
}

function probeGif(url: string, fps: number, release: () => void): Promise<MediaMetadata> {
  const fallbackFrames = Math.round(GIF_SECONDS_FALLBACK * fps);
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const done = (metadata: MediaMetadata) => { release(); resolve(metadata); };
    video.preload = 'metadata';
    video.onloadedmetadata = () => done({
      durationInFrames: Number.isFinite(video.duration) && video.duration > 0
        ? Math.max(1, Math.round(video.duration * fps)) : fallbackFrames,
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
    });
    video.onerror = () => {
      const image = new Image();
      image.onload = () => done({ durationInFrames: fallbackFrames, width: image.naturalWidth || undefined, height: image.naturalHeight || undefined });
      image.onerror = () => done({ durationInFrames: fallbackFrames });
      image.src = url;
    };
    video.src = url;
  });
}

function probeTimed(url: string, kind: 'video' | 'audio', fps: number, release: () => void): Promise<MediaMetadata> {
  return new Promise((resolve) => {
    const element = kind === 'video' ? document.createElement('video') : document.createElement('audio');
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      release();
      resolve({
        durationInFrames: Math.max(1, Math.round((element.duration || IMAGE_SECONDS) * fps)),
        width: element instanceof HTMLVideoElement ? element.videoWidth : undefined,
        height: element instanceof HTMLVideoElement ? element.videoHeight : undefined,
      });
    };
    element.onerror = () => { release(); resolve({ durationInFrames: Math.round(IMAGE_SECONDS * fps) }); };
    element.src = url;
  });
}

export function probeMediaSource(url: string, kind: MediaKind, fps: number, release: () => void = () => undefined): Promise<MediaMetadata> {
  if (kind === 'image' || kind === 'svg') return probeStill(url, Math.round(IMAGE_SECONDS * fps), release);
  if (kind === 'gif') return probeGif(url, fps, release);
  return probeTimed(url, kind, fps, release);
}

export function probeMediaFile(file: File, kind: MediaKind, fps: number): Promise<MediaMetadata> {
  const url = URL.createObjectURL(file);
  return probeMediaSource(url, kind, fps, () => URL.revokeObjectURL(url));
}
