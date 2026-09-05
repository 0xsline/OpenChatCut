import type { ProjectDoc, Timeline, TimelineState } from '../../src/editor/types.ts';
import { resolveTimelineRenderPlan, sequenceGraphError } from '../../src/editor/sequenceGraph.ts';
import { isTimelineState } from '../../src/persist/migrations/normalize.ts';
import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import { normalizeFrameRange } from '../../src/export/range.ts';
import {
  EXPORT_FPS_OPTIONS,
  EXPORT_RESOLUTIONS,
  exportScale,
  type ExportResolution,
} from '../../src/export/mediaSettings.ts';
import { MAX_VIDEO_BITRATE_BPS, MIN_VIDEO_BITRATE_BPS } from '../../src/export/bitrate.ts';
import { sanitizeFileName } from '../file-name.ts';

export { EXPORT_FPS_OPTIONS, EXPORT_RESOLUTIONS, exportScale } from '../../src/export/mediaSettings.ts';
export type { ExportResolution } from '../../src/export/mediaSettings.ts';

export type ExportRequest = {
  state?: unknown;
  project?: unknown;
  timelineId?: unknown;
  operationId?: unknown;
  format?: 'video' | 'audio';
  codec?: 'h264' | 'vp8' | 'prores' | 'mp3' | 'wav';
  name?: string;
  startFrame?: number;
  endFrameExclusive?: number;
  startSeconds?: number;
  endSeconds?: number;
  resolution?: ExportResolution;
  fps?: number;
  videoBitrate?: number;
};

export type ExportTimeline = {
  fps: number;
  items: Array<{ startFrame: number; durationInFrames: number }>;
};

export const EXPORT_MEDIA = {
  h264: { codec: 'h264', ext: 'mp4', mime: 'video/mp4' },
  vp8: { codec: 'vp8', ext: 'webm', mime: 'video/webm' },
  /** Mezzanine master: ProRes 422 HQ (Remotion proResProfile hq). Server-only. */
  prores: { codec: 'prores', ext: 'mov', mime: 'video/quicktime' },
  mp3: { codec: 'mp3', ext: 'mp3', mime: 'audio/mpeg' },
  wav: { codec: 'wav', ext: 'wav', mime: 'audio/wav' },
} as const;
export interface ExportPlan {
  state: TimelineState;
  project?: ProjectDoc;
  timelineId?: string;
  format: 'video' | 'audio';
  media: (typeof EXPORT_MEDIA)[keyof typeof EXPORT_MEDIA];
  frameRange: [number, number] | undefined;
  totalFrames: number;
  filename: string;
  durationSeconds: number;
  scale: number;
  retimeFps: number | undefined;
  videoBitrate: number | undefined;
}

class ExportRequestError extends Error {}

export function validateVideoParams(
  body: { resolution?: unknown; fps?: unknown; videoBitrate?: unknown } | null,
  format: 'video' | 'audio',
): void {
  if (body?.resolution !== undefined) {
    if (format !== 'video') throw new ExportRequestError('resolution applies to video exports only');
    if (typeof body.resolution !== 'string' || !Object.hasOwn(EXPORT_RESOLUTIONS, body.resolution)) {
      throw new ExportRequestError('resolution must be 480p, 720p, 1080p, or 4k');
    }
  }
  if (body?.fps !== undefined) {
    if (format !== 'video') throw new ExportRequestError('fps applies to video exports only');
    if (typeof body.fps !== 'number' || !(EXPORT_FPS_OPTIONS as readonly number[]).includes(body.fps)) {
      throw new ExportRequestError('fps must be 24, 25, 30, 50, or 60');
    }
  }
  if (body?.videoBitrate !== undefined) {
    if (format !== 'video') throw new ExportRequestError('videoBitrate applies to video exports only');
    if (!Number.isInteger(body.videoBitrate)
      || (body.videoBitrate as number) < MIN_VIDEO_BITRATE_BPS
      || (body.videoBitrate as number) > MAX_VIDEO_BITRATE_BPS) {
      throw new ExportRequestError('videoBitrate must be an integer between 1000000 and 80000000 bps');
    }
  }
}

export function exportFilename(name: string | undefined, ext: string): string {
  const base = sanitizeFileName((name ?? 'export').replace(/\.(?:mp4|webm|mov|mp3|wav)$/i, ''), 'export');
  return `${base}.${ext}`;
}

export function exportDuration(state: ExportTimeline): number {
  return Math.max(
    state.fps,
    state.items.reduce((end, item) => Math.max(end, item.startFrame + item.durationInFrames), 0),
  );
}

function isTimeline(value: unknown): value is Timeline {
  return isTimelineState(value)
    && 'id' in value
    && typeof value.id === 'string'
    && 'name' in value
    && typeof value.name === 'string'
    && 'order' in value
    && typeof value.order === 'number';
}

function currentTimelinesFrom(value: unknown): Timeline[] | null {
  if (!value || typeof value !== 'object' || !('timelines' in value) || !Array.isArray(value.timelines)) return null;
  return value.timelines.every(isTimeline) ? value.timelines : null;
}

export function planExport(body: ExportRequest | null): ExportPlan {
  const requestedState = body?.state;
  if (!isTimelineState(requestedState)) {
    throw new ExportRequestError('body must be { state: TimelineState } with a valid items array');
  }
  let state = requestedState;
  let project: ProjectDoc | undefined;
  let timelineId: string | undefined;
  let nestedDuration: number | undefined;
  if (body?.project !== undefined) {
    const currentTimelines = currentTimelinesFrom(body.project);
    const graphError = currentTimelines ? sequenceGraphError({ timelines: currentTimelines }) : null;
    if (graphError) throw graphError;
    const migrated = runProjectMigrations(body.project);
    if (!migrated) {
      throw new ExportRequestError('project must be a valid current or legacy ProjectDoc');
    }
    const migratedProject = migrated.doc;
    project = migratedProject;
    if (body.timelineId !== undefined && (typeof body.timelineId !== 'string' || !body.timelineId)) {
      throw new ExportRequestError('timelineId must be a non-empty string');
    }
    const selectedTimelineId = body.timelineId ?? migratedProject.activeTimelineId;
    timelineId = selectedTimelineId;
    const root = migratedProject.timelines.find((timeline: Timeline) => timeline.id === selectedTimelineId);
    if (!root) throw new ExportRequestError(`timeline ${selectedTimelineId} not found in project`);
    const nestedPlan = resolveTimelineRenderPlan(migratedProject, selectedTimelineId);
    state = root;
    nestedDuration = nestedPlan.durationInFrames;
  } else if (body?.timelineId !== undefined) {
    throw new ExportRequestError('timelineId requires project');
  }
  const fps = state.fps;
  if (!Number.isFinite(fps) || fps <= 0) throw new ExportRequestError('state.fps must be a positive number');
  if (body?.format !== undefined && body.format !== 'video' && body.format !== 'audio') {
    throw new ExportRequestError('format must be video or audio');
  }
  if (body?.codec !== undefined && !Object.hasOwn(EXPORT_MEDIA, body.codec)) {
    throw new ExportRequestError('codec must be h264, vp8, prores, mp3, or wav');
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
  if (format === 'video' && codec === 'prores' && body?.videoBitrate !== undefined) {
    throw new ExportRequestError('prores mezzanine export does not accept videoBitrate');
  }
  validateVideoParams(body, format);
  const totalFrames = nestedDuration === undefined
    ? exportDuration(state)
    : Math.max(fps, nestedDuration);
  const startFrame = body?.startFrame ?? (body?.startSeconds === undefined ? undefined : Math.floor(body.startSeconds * fps));
  const endFrame = body?.endFrameExclusive ?? (body?.endSeconds === undefined ? undefined : Math.ceil(body.endSeconds * fps));
  const frameRange = normalizeFrameRange(totalFrames, startFrame, endFrame);
  const frames = frameRange ? frameRange[1] - frameRange[0] + 1 : totalFrames;
  const media = EXPORT_MEDIA[codec];
  // ProRes is mezzanine-only: no fps retime pass (that path is H.264/VP8).
  const retimeFps = format === 'video' && codec !== 'prores'
    && body?.fps !== undefined && body.fps !== fps
    ? body.fps
    : undefined;
  return {
    state,
    project,
    timelineId,
    format,
    media,
    frameRange,
    totalFrames: frames,
    filename: exportFilename(body?.name, media.ext),
    // A retime pass keeps the frame count and changes the container fps, so
    // the produced file's duration follows the OUTPUT fps. Reporting the
    // timeline fps here made every resampled export fail its own duration QA.
    durationSeconds: frames / (retimeFps ?? fps),
    scale: exportScale(state, body?.resolution),
    retimeFps,
    videoBitrate: format === 'video' && codec !== 'prores' ? body?.videoBitrate : undefined,
  };
}
