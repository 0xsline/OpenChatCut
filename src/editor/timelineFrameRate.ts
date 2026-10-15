import { EXPORT_FPS_OPTIONS } from '../export/mediaSettings';
import {
  activeTimeline,
  captionTrackEntries,
  isTimelineMediaAssetKind,
  type MediaAsset,
  type MediaAssetKind,
  type ProjectDoc,
  type TimelineState,
} from './types';

/**
 * Frame rates a timeline can be set to. They are the rates every export route
 * delivers without retiming: the browser path requires export fps == timeline
 * fps, and the local renderer only accepts these as a retime target. A
 * 59.94/29.97 timeline (possible through MCP) always exports retimed.
 */
export const TIMELINE_FPS_OPTIONS: readonly number[] = EXPORT_FPS_OPTIONS;

/** 60000/1001 reads as 59.94; whole rates stay whole. */
export function formatFrameRate(fps: number): string {
  return String(Math.round(fps * 100) / 100);
}

/** Shown while a project cannot change frame rate; also the i18n key. */
export const FRAME_RATE_LOCKED_REASON = '帧率需在时间线添加内容前设置';

/** Anything the timeline positions in frames at its current rate. */
function timelineHasFramedContent(timeline: TimelineState): boolean {
  return timeline.items.length > 0
    || !!timeline.transitions?.length
    || !!timeline.markers?.length
    || !!timeline.linkGroups?.length
    || !!timeline.multicamGroups?.length
    || !!timeline.captions
    || captionTrackEntries(timeline).some((entry) => !!entry.captions);
}

/**
 * Null while the project's frame rate can change, else why not. Every timeline
 * position, duration, keyframe, marker and caption offset is a frame count at
 * the current rate, so the rate is only offered before anything is placed.
 * One rate covers the whole project: nested sequences must share it, and pool
 * durations are counted in it.
 */
export function projectFrameRateLock(doc: ProjectDoc): string | null {
  return doc.timelines.some(timelineHasFramedContent) ? FRAME_RATE_LOCKED_REASON : null;
}

const isRate = (fps: number | undefined): fps is number => Number.isFinite(fps) && fps! > 0;

/**
 * Pool durations are probed as seconds x the rate at import, and the rate can
 * change before an import lands (an upload still transcoding, an agent's media
 * replayed onto the live project). Recount a duration counted at `countedAt`
 * at `fps`; a motion graphic's length is authored in frames and the timeline
 * plays it frame for frame, so it stays as authored.
 */
export function recountDuration(kind: MediaAssetKind, frames: number, countedAt: number | undefined, fps: number | undefined): number {
  if (!isTimelineMediaAssetKind(kind) || kind === 'motion-graphic') return frames;
  if (!Number.isFinite(frames) || frames <= 0 || !isRate(countedAt) || !isRate(fps) || countedAt === fps) return frames;
  return Math.max(1, Math.round(frames * (fps / countedAt)));
}

export function recountAssetDuration(asset: MediaAsset, countedAt: number | undefined, fps: number | undefined): MediaAsset {
  const durationInFrames = recountDuration(asset.kind, asset.durationInFrames, countedAt, fps);
  return durationInFrames === asset.durationInFrames ? asset : { ...asset, durationInFrames };
}

/** Set every timeline to `fps`; the same doc back when the rate is unsupported, unchanged or locked. */
export function withProjectFrameRate(doc: ProjectDoc, fps: number): ProjectDoc {
  if (!TIMELINE_FPS_OPTIONS.includes(fps) || projectFrameRateLock(doc)) return doc;
  if (doc.timelines.every((timeline) => timeline.fps === fps)) return doc;
  const previous = activeTimeline(doc)?.fps;
  return {
    ...doc,
    timelines: doc.timelines.map((timeline) => (timeline.fps === fps ? timeline : { ...timeline, fps })),
    assets: !isRate(previous) || previous === fps
      ? doc.assets
      : doc.assets.map((asset) => recountAssetDuration(asset, previous, fps)),
  };
}
