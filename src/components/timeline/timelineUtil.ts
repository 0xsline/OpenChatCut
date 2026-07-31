// Timeline shared base: layout constants, timecode/ruler formatting, drag type, audio waveform.
// The main Timeline component and the removed component components (Toolbar/Ruler/TrackLane/useTimelinePointer) are taken from here.
// Ensure that geometry and copy have only one true source. All copied verbatim from the top of Timeline.tsx.
import { theme } from '../../theme';
import type { TimelineItem, TimelineState, TrackId, TransitionItem } from '../../editor/types';

/** sticky track-head: pad 16 + compact label + track actions + 4px gaps */
export const HEADER_W = 212;
export const MIN_ROW = 34;
export const RULER_H = 28;
/** Equal-height tracks without per-row duck controls. */
export const TRACK_ROW = 56;
export const MAX_ROW = 72;
// Clip fill by item kind: video/image=blue, audio=green,
// motion-graphic=pink, text=amber). Video/image also render a media thumbnail on top.
export const CLIP_COLOR: Record<TimelineItem['kind'], string> = {
  video: theme.clipVideo, image: theme.clipVideo, gif: theme.clipVideo, svg: theme.clipVideo,
  solid: '#4a5568',
  audio: theme.clipAudio,
  'motion-graphic': theme.clipMg, text: theme.clipText,
};
/** default time scale — 1s ≈ 36px @30fps (shorter clips, less “giant color block”) */
export const PX_PER_FRAME = 1.2;
export const MIN_TIME_ZOOM = 0.02; // long timelines (3–8 min) must still fit in one viewport
/** Target minimum pixels between major ruler labels. */
export const RULER_LABEL_MIN_PX = 52;

export const TIMELINE_OVERSCAN_PX = 480;
export const MAX_RULER_TICKS = 190;

export interface TimelineFrameWindow {
  startFrame: number;
  endFrame: number;
}

export interface TimelineTrackItemIndex {
  items: readonly TimelineItem[];
  maxEndFrames: readonly number[];
}

export interface TimelineIndexes {
  itemsByTrack: ReadonlyMap<TrackId, readonly TimelineItem[]>;
  itemById: ReadonlyMap<string, TimelineItem>;
  transitionsByTrack: ReadonlyMap<TrackId, readonly TransitionItem[]>;
  transitionByIncomingId: ReadonlyMap<string, TransitionItem>;
  itemWindowsByTrack: ReadonlyMap<TrackId, TimelineTrackItemIndex>;
  itemOrderById: ReadonlyMap<string, number>;
}

export function timelineFrameWindow(
  scrollLeft: number,
  clientWidth: number,
  pxPerFrame: number,
  overscanPx = TIMELINE_OVERSCAN_PX,
): TimelineFrameWindow {
  const px = Math.max(0.001, pxPerFrame);
  const startFrame = Math.max(0, Math.floor((scrollLeft - HEADER_W - overscanPx) / px));
  const endFrame = Math.max(startFrame + 1, Math.ceil((scrollLeft + clientWidth - HEADER_W + overscanPx) / px));
  return { startFrame, endFrame };
}

export function intersectFrameRange(
  startFrame: number,
  durationInFrames: number,
  window: TimelineFrameWindow,
): TimelineFrameWindow | null {
  const start = Math.max(startFrame, window.startFrame);
  const end = Math.min(startFrame + Math.max(0, durationInFrames), window.endFrame);
  return end > start ? { startFrame: start, endFrame: end } : null;
}

export function framePointInWindow(frame: number, window: TimelineFrameWindow): boolean {
  return frame >= window.startFrame && frame < window.endFrame;
}

function trackItemWindowIndex(items: readonly TimelineItem[]): TimelineTrackItemIndex {
  const sorted = [...items].sort((a, b) => a.startFrame - b.startFrame);
  const maxEndFrames: number[] = [];
  let maxEnd = -Infinity;
  for (const item of sorted) {
    maxEnd = Math.max(maxEnd, item.startFrame + item.durationInFrames);
    maxEndFrames.push(maxEnd);
  }
  return { items: sorted, maxEndFrames };
}

export function buildTimelineIndexes(state: TimelineState): TimelineIndexes {
  const itemsByTrack = new Map<TrackId, TimelineItem[]>();
  const itemById = new Map<string, TimelineItem>();
  const itemOrderById = new Map<string, number>();
  state.items.forEach((item, order) => {
    const items = itemsByTrack.get(item.track);
    if (items) items.push(item);
    else itemsByTrack.set(item.track, [item]);
    if (!itemById.has(item.id)) itemById.set(item.id, item);
    if (!itemOrderById.has(item.id)) itemOrderById.set(item.id, order);
  });
  const transitionsByTrack = new Map<TrackId, TransitionItem[]>();
  const transitionByIncomingId = new Map<string, TransitionItem>();
  for (const transition of state.transitions ?? []) {
    const transitions = transitionsByTrack.get(transition.trackId);
    if (transitions) transitions.push(transition);
    else transitionsByTrack.set(transition.trackId, [transition]);
    if (!transitionByIncomingId.has(transition.incomingItemId)) {
      transitionByIncomingId.set(transition.incomingItemId, transition);
    }
  }
  const itemWindowsByTrack = new Map<TrackId, TimelineTrackItemIndex>();
  itemsByTrack.forEach((items, trackId) => itemWindowsByTrack.set(trackId, trackItemWindowIndex(items)));
  return { itemsByTrack, itemById, transitionsByTrack, transitionByIncomingId, itemWindowsByTrack, itemOrderById };
}

function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundItemStart(items: readonly TimelineItem[], target: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid]!.startFrame < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function visibleTimelineItems(
  index: TimelineTrackItemIndex | undefined,
  window: TimelineFrameWindow,
  pinnedIds: ReadonlySet<string>,
  itemById: ReadonlyMap<string, TimelineItem>,
  itemOrderById: ReadonlyMap<string, number>,
  trackId: TrackId,
): TimelineItem[] {
  const visible = new Map<string, TimelineItem>();
  if (index) {
    const first = lowerBound(index.maxEndFrames, window.startFrame);
    const last = lowerBoundItemStart(index.items, window.endFrame);
    for (let i = first; i < last; i += 1) {
      const item = index.items[i]!;
      if (intersectFrameRange(item.startFrame, item.durationInFrames, window)) visible.set(item.id, item);
    }
  }
  for (const id of pinnedIds) {
    const item = itemById.get(id);
    if (item?.track === trackId) visible.set(id, item);
  }
  return [...visible.values()].sort((a, b) => (itemOrderById.get(a.id) ?? 0) - (itemOrderById.get(b.id) ?? 0));
}

export function timelinePinnedItemIds(
  selectedIds: Iterable<string>,
  interactionIds: Iterable<string | null | undefined>,
  transitions: readonly TransitionItem[],
): ReadonlySet<string> {
  const pinned = new Set(selectedIds);
  for (const id of interactionIds) if (id) pinned.add(id);
  const seeds = new Set(pinned);
  for (const transition of transitions) {
    if (!seeds.has(transition.incomingItemId) && !seeds.has(transition.outgoingItemId)) continue;
    pinned.add(transition.incomingItemId);
    pinned.add(transition.outgoingItemId);
  }
  return pinned;
}

export function rulerTickWindow(
  window: TimelineFrameWindow,
  endFrame: number,
  majorFrames: number,
  minorTicksPerMajor: number,
): { firstMajor: number; majorCount: number; majorStride: number; minorStride: number } {
  const firstMajor = Math.max(0, Math.floor(window.startFrame / majorFrames));
  const lastMajor = Math.min(Math.ceil(endFrame / majorFrames), Math.ceil(window.endFrame / majorFrames));
  const rawMajorCount = Math.max(0, lastMajor - firstMajor + 1);
  const majorStride = Math.max(1, Math.ceil(rawMajorCount / MAX_RULER_TICKS));
  const majorCount = Math.ceil(rawMajorCount / majorStride);
  const minorBudget = Math.max(0, MAX_RULER_TICKS - majorCount);
  const minorTotal = majorCount * minorTicksPerMajor;
  const minorStride = minorBudget > 0 ? Math.max(1, Math.ceil(minorTotal / minorBudget)) : Infinity;
  return { firstMajor, majorCount, majorStride, minorStride };
}

export function fmt(frames: number, fps: number): string {
  const s = frames / fps;
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function fmtClock(frames: number, fps: number): string {
  const seconds = Math.floor(frames / fps);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** pick major tick step (seconds) so labels stay readable at current zoom */
export function rulerMajorSeconds(pxPerFrame: number, fps: number): number {
  // finer steps so zoomed-in timelines get sub-second / few-second marks
  const options = [0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of options) {
    if (s * fps * pxPerFrame >= RULER_LABEL_MIN_PX) return s;
  }
  return 600;
}

/** number of minor ticks between majors (more when majors are far apart) */
export function rulerMinorCount(majorSec: number): number {
  if (majorSec <= 0.5) return 1;
  if (majorSec <= 2) return 3;
  if (majorSec <= 10) return 4;
  if (majorSec <= 30) return 5;
  return 9;
}

export function fmtRuler(frames: number, fps: number): string {
  const s = frames / fps;
  if (s < 60) {
    const ss = Math.floor(s);
    const cs = Math.floor((s * 100) % 100);
    return `${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

export type DragMode = 'move' | 'trim-left' | 'trim-right';
export type EditMode = 'selection' | 'blade' | 'trim' | 'pen' | 'rate-stretch';
export interface Drag {
  id: string; mode: DragMode; baseStart: number; baseDur: number; baseTrack: TrackId;
  baseSrcIn: number; startX: number; deltaF: number; targetTrack: TrackId; snapAt: number | null;
}
// how close (px) an edge must come to a snap target before it locks on
export const SNAP_PX = 7;

// Paint dense, filled audio peaks instead of a repeated decorative zig-zag.
// Generate a stable waveform from clip identity so the
// same project keeps the same visual shape without decoding audio in React.
export function waveformPath(seed: string, width: number): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  const count = Math.min(1200, Math.max(24, Math.ceil(width / 2)));
  const bars: string[] = [];
  for (let i = 0; i < count; i += 1) {
    hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
    const envelope = 0.55 + 0.45 * Math.sin((i / (count - 1)) * Math.PI);
    const amplitude = 2.5 + ((hash >>> 0) % 850) / 100 * envelope;
    const x = (i / (count - 1)) * width;
    bars.push(`M${x.toFixed(2)} ${(12 - amplitude).toFixed(2)}V${(12 + amplitude).toFixed(2)}`);
  }
  return bars.join(' ');
}
