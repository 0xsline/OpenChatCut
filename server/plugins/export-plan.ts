import { normalizeFrameRange } from '../../src/export/range.ts';
import {
  EXPORT_FPS_OPTIONS,
  EXPORT_RESOLUTIONS,
  exportScale,
  type ExportResolution,
} from '../../src/export/mediaSettings.ts';
import { sanitizeFileName } from '../file-name.ts';

export { EXPORT_FPS_OPTIONS, EXPORT_RESOLUTIONS, exportScale } from '../../src/export/mediaSettings.ts';
export type { ExportResolution } from '../../src/export/mediaSettings.ts';

export type ExportRequest = {
  state?: unknown;
  format?: 'video' | 'audio';
  codec?: 'h264' | 'vp8' | 'mp3' | 'wav';
  name?: string;
  startFrame?: number;
  endFrameExclusive?: number;
  startSeconds?: number;
  endSeconds?: number;
  resolution?: ExportResolution;
  fps?: number;
};

export type ExportTimeline = {
  fps: number;
  items: Array<{ startFrame: number; durationInFrames: number }>;
};

export const EXPORT_MEDIA = {
  h264: { codec: 'h264', ext: 'mp4', mime: 'video/mp4' },
  vp8: { codec: 'vp8', ext: 'webm', mime: 'video/webm' },
  mp3: { codec: 'mp3', ext: 'mp3', mime: 'audio/mpeg' },
  wav: { codec: 'wav', ext: 'wav', mime: 'audio/wav' },
} as const;

export interface ExportPlan {
  state: unknown;
  format: 'video' | 'audio';
  media: (typeof EXPORT_MEDIA)[keyof typeof EXPORT_MEDIA];
  frameRange: [number, number] | undefined;
  totalFrames: number;
  filename: string;
  durationSeconds: number;
  scale: number;
  retimeFps: number | undefined;
}

class ExportRequestError extends Error {}

export function validateVideoParams(
  body: { resolution?: unknown; fps?: unknown } | null,
  format: 'video' | 'audio',
): void {
  if (body?.resolution !== undefined) {
    if (format !== 'video') throw new ExportRequestError('resolution applies to video exports only');
    if (typeof body.resolution !== 'string' || !(body.resolution in EXPORT_RESOLUTIONS)) {
      throw new ExportRequestError('resolution must be 480p, 720p, or 1080p');
    }
  }
  if (body?.fps !== undefined) {
    if (format !== 'video') throw new ExportRequestError('fps applies to video exports only');
    if (typeof body.fps !== 'number' || !(EXPORT_FPS_OPTIONS as readonly number[]).includes(body.fps)) {
      throw new ExportRequestError('fps must be 24, 25, 30, 50, or 60');
    }
  }
}

export function exportFilename(name: string | undefined, ext: string): string {
  const base = sanitizeFileName((name ?? 'export').replace(/\.(?:mp4|webm|mp3|wav)$/i, ''), 'export');
  return `${base}.${ext}`;
}

export function exportDuration(state: ExportTimeline): number {
  return Math.max(
    state.fps,
    state.items.reduce((end, item) => Math.max(end, item.startFrame + item.durationInFrames), 0),
  );
}

export function planExport(body: ExportRequest | null): ExportPlan {
  const state = body?.state;
  if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
    throw new ExportRequestError('body must be { state: TimelineState } with an items array');
  }
  const fps = (state as ExportTimeline).fps;
  if (!Number.isFinite(fps) || fps <= 0) throw new ExportRequestError('state.fps must be a positive number');
  if (body?.format !== undefined && body.format !== 'video' && body.format !== 'audio') {
    throw new ExportRequestError('format must be video or audio');
  }
  if (body?.codec !== undefined && !Object.hasOwn(EXPORT_MEDIA, body.codec)) {
    throw new ExportRequestError('codec must be h264, vp8, mp3, or wav');
  }
  if (body?.name !== undefined && typeof body.name !== 'string') throw new ExportRequestError('name must be a string');
  if ([body?.startSeconds, body?.endSeconds].some((value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new ExportRequestError('startSeconds and endSeconds must be finite numbers');
  }
  const format = body?.format ?? 'video';
  const codec = body?.codec ?? (format === 'audio' ? 'mp3' : 'h264');
  if ((format === 'audio') !== (codec === 'mp3' || codec === 'wav')) {
    throw new ExportRequestError(`${format} export does not support codec=${codec}`);
  }
  validateVideoParams(body, format);
  const totalFrames = exportDuration(state as ExportTimeline);
  const startFrame = body?.startFrame ?? (body?.startSeconds === undefined ? undefined : Math.floor(body.startSeconds * fps));
  const endFrame = body?.endFrameExclusive ?? (body?.endSeconds === undefined ? undefined : Math.ceil(body.endSeconds * fps));
  const frameRange = normalizeFrameRange(totalFrames, startFrame, endFrame);
  const frames = frameRange ? frameRange[1] - frameRange[0] + 1 : totalFrames;
  const media = EXPORT_MEDIA[codec];
  return {
    state,
    format,
    media,
    frameRange,
    totalFrames: frames,
    filename: exportFilename(body?.name, media.ext),
    durationSeconds: frames / fps,
    scale: exportScale(state as { width?: unknown; height?: unknown }, body?.resolution),
    retimeFps: format === 'video' && body?.fps !== undefined && body.fps !== fps ? body.fps : undefined,
  };
}
