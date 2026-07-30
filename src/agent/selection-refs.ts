// Selection mode + rich @ references.
// Lets the user "point at" things while composing: timeline clips
// (type 'item'), ruler timepoints/timeranges (category 'time'), a marquee on the
// preview canvas (category 'region', composition coordinates) and transcript word
// spans (category 'transcript'). Each pick becomes a mention chip whose prompt
// token is @t[…] (time) / @r[…] (region) / @q[…] (transcript) / @[…] (item).
// Panels report picks via a window event (window "openchatcut:items-clicked|time-marked|
// canvas-region-marked|transcript-selected"); a module store carries the
// selection-mode flag (isSelectionMode) so panels deep inside other
// panels (transcript lives in LibraryPanel) need no prop drilling.

import { useSyncExternalStore } from 'react';
import {
  trackAlias, trackKind,
  type Timeline, type TimelineItem, type TimelineState, type TrackId,
} from '../editor/types';
import { makeWordFrameMapper } from './tools/transcript-find';
import { isCjkText, speakerLabel } from '../transcript/segment';

/** Media-pool / template mention kinds (the pre-existing @ 引用). */
export type AssetRefKind = 'video' | 'image' | 'audio' | 'motion-graphic' | 'gif' | 'svg' | 'template';

// ── metadata per reference type ─────────────────────────────────────────────

export interface TimepointMetadata {
  fps: number;
  timelineId?: string;
  timelineFrameStart: number;
}

export interface TimerangeMetadata {
  fps: number;
  timelineId?: string;
  itemId?: string;
  trackId?: string;
  trackAlias?: string;
  timelineFrameStart: number;
  /** exclusive end frame */
  timelineFrameEnd: number;
}

export interface CanvasRegionMetadata {
  fps: number;
  timelineId?: string;
  /** region in COMPOSITION coordinates */
  regionX: number;
  regionY: number;
  regionWidth: number;
  regionHeight: number;
  compositionWidth: number;
  compositionHeight: number;
  /** ids of visual clips intersecting the region at the marked frame */
  containedItems: string[];
  timelineFrameStart: number;
}

export interface TranscriptSelectionMetadata {
  fps: number;
  timelineId?: string;
  /** media-pool master; resolved at send time from the item's src */
  assetId?: string;
  itemId: string;
  selectedText: string;
  /** indices into the clip's transcript[] (词级真源 gi) */
  selectedWordIds: number[];
  selectedWords: { text: string; start: number; end: number }[];
  /** source-media ms straight from the word-level timestamps */
  sourceMediaStartMs: number;
  sourceMediaEndMs: number;
  /** Edited-timeline frames via keptSegments math; undefined if all selected words are cut. */
  timelineFrameStart?: number;
  timelineFrameEnd?: number;
  speakerName?: string;
}

export interface ItemRefMetadata {
  fps: number;
  timelineId?: string;
  itemId: string;
  itemKind: TimelineItem['kind'];
  trackId: string;
  trackAlias?: string;
  timelineFrameStart: number;
  /** exclusive end frame */
  timelineFrameEnd: number;
}

interface RefBase { id: string; name: string }

/** The five selection-mode reference types (discriminated on `kind`). */
export type SelectionReference =
  | (RefBase & { kind: 'item'; metadata: ItemRefMetadata })
  | (RefBase & { kind: 'timepoint'; metadata: TimepointMetadata })
  | (RefBase & { kind: 'timerange'; metadata: TimerangeMetadata })
  | (RefBase & { kind: 'canvas-region'; metadata: CanvasRegionMetadata })
  | (RefBase & { kind: 'transcript-selection'; metadata: TranscriptSelectionMetadata });

export type SelectionRefKind = SelectionReference['kind'];

  /** Reference `category` for each type ('time' | 'region' | 'transcript' | 'item'). */
export const SELECTION_REF_CATEGORY: Record<SelectionRefKind, string> = {
  item: 'item',
  timepoint: 'time',
  timerange: 'time',
  'canvas-region': 'region',
  'transcript-selection': 'transcript',
};

export function isSelectionRefKind(kind: string): kind is SelectionRefKind {
  return Object.prototype.hasOwnProperty.call(SELECTION_REF_CATEGORY, kind);
}

// ── serialization ────────────────────────────────────────────────────────────

/** Prompt token for a mention: time → @t[…], region →
 * @r[…], transcript → @q[…], item → @[…]; pool assets/templates keep the
 * pre-existing plain `@name` form. */
export function refPromptToken(ref: { name: string; kind: string }): string {
  if (ref.kind === 'timepoint' || ref.kind === 'timerange') return `@t[${ref.name}]`;
  if (ref.kind === 'canvas-region') return `@r[${ref.name}]`;
  if (ref.kind === 'transcript-selection') return `@q[${ref.name}]`;
  if (ref.kind === 'item') return `@[${ref.name}]`;
  return `@${ref.name}`;
}

/** mm:ss.d human timecode for chips (e.g. 156f @30fps → "00:05.2"). */
export function formatFrameTime(frame: number, fps: number): string {
  const seconds = Math.max(0, frame) / Math.max(1, fps);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
}

/** Active timeline id when the state came from activeEditorState (a Timeline at runtime). */
export function timelineIdOf(state: TimelineState): string | undefined {
  const id = (state as Partial<Timeline>).id;
  return typeof id === 'string' ? id : undefined;
}

// ── reference builders ───────────────────────────────────────────────────────

export function timepointRef(frame: number, state: TimelineState): SelectionReference {
  const f = Math.max(0, Math.round(frame));
  return {
    id: `time:${f}`,
    name: `${formatFrameTime(f, state.fps)} 时间点`,
    kind: 'timepoint',
    metadata: { fps: state.fps, timelineId: timelineIdOf(state), timelineFrameStart: f },
  };
}

export function timerangeRef(
  fromFrame: number,
  toFrameExclusive: number,
  state: TimelineState,
  opts: { trackId?: TrackId; itemId?: string } = {},
): SelectionReference {
  const lo = Math.max(0, Math.round(Math.min(fromFrame, toFrameExclusive)));
  const hi = Math.max(lo + 1, Math.round(Math.max(fromFrame, toFrameExclusive)));
  const alias = opts.trackId ? trackAlias(state, opts.trackId) : undefined;
  return {
    id: `time:${lo}-${hi}${opts.trackId ? `:${opts.trackId}` : ''}`,
    name: `${alias ? `${alias} ` : ''}${formatFrameTime(lo, state.fps)}-${formatFrameTime(hi, state.fps)}`,
    kind: 'timerange',
    metadata: {
      fps: state.fps,
      timelineId: timelineIdOf(state),
      ...(opts.itemId ? { itemId: opts.itemId } : {}),
      ...(opts.trackId ? { trackId: opts.trackId, trackAlias: alias } : {}),
      timelineFrameStart: lo,
      timelineFrameEnd: hi,
    },
  };
}

export function itemRef(item: TimelineItem, state: TimelineState): SelectionReference {
  return {
    id: item.id,
    name: item.name || item.id,
    kind: 'item',
    metadata: {
      fps: state.fps,
      timelineId: timelineIdOf(state),
      itemId: item.id,
      itemKind: item.kind,
      trackId: item.track,
      trackAlias: trackAlias(state, item.track),
      timelineFrameStart: item.startFrame,
      timelineFrameEnd: item.startFrame + item.durationInFrames,
    },
  };
}

// ── timeline pick gesture → reference ────────────────────────────────────────

export interface TimelinePickDrag {
  /** where the pointer went down: ruler, empty lane, or a clip */
  origin: 'ruler' | 'lane' | 'clip';
  startFrame: number;
  endFrame: number;
  trackId?: TrackId;
  item?: TimelineItem;
}

/** Completed selection-mode gesture on the timeline → the reference it means:
 * dragged → timerange (with track/item context); clip click → item; ruler
 * click → timepoint; empty-lane click → nothing. */
export function resolveTimelinePick(
  drag: TimelinePickDrag,
  clickThresholdFrames: number,
  state: TimelineState,
): SelectionReference | null {
  const moved = Math.abs(drag.endFrame - drag.startFrame) > Math.max(1, clickThresholdFrames);
  if (moved) {
    const trackId = drag.item?.track ?? drag.trackId;
    return timerangeRef(drag.startFrame, drag.endFrame, state, { trackId, itemId: drag.item?.id });
  }
  if (drag.origin === 'clip' && drag.item) return itemRef(drag.item, state);
  if (drag.origin === 'ruler') return timepointRef(drag.startFrame, state);
  return null;
}

// ── canvas region math (composition coordinates) ─────────────────────────────

export interface RegionRect { x: number; y: number; width: number; height: number }

/** Marquee in view px → integer composition-space rect (clamped to the canvas);
 * null when degenerate (< 2 composition px on a side). */
export function regionFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
  viewW: number,
  viewH: number,
  compW: number,
  compH: number,
): RegionRect | null {
  if (viewW <= 0 || viewH <= 0 || compW <= 0 || compH <= 0) return null;
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
  const x0 = Math.round((clamp(Math.min(a.x, b.x), viewW) / viewW) * compW);
  const y0 = Math.round((clamp(Math.min(a.y, b.y), viewH) / viewH) * compH);
  const x1 = Math.round((clamp(Math.max(a.x, b.x), viewW) / viewW) * compW);
  const y1 = Math.round((clamp(Math.max(a.y, b.y), viewH) / viewH) * compH);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 2 || height < 2) return null;
  return { x: x0, y: y0, width, height };
}

/** Approximate rendered rect of a visual clip in composition space. Mirrors
 * TimelineComposition: raster media fills the canvas; MG/text render their
 * design box contain-scaled + centered; transform = scale about canvas center
 * then translate by percent of canvas. Audio → null.
 * ponytail: rotation + fit='cover' crop not modeled — AABB approximation for
 * region picking; model them if region precision ever matters. */
export function itemRectInComposition(item: TimelineItem, compW: number, compH: number): RegionRect | null {
  if (item.kind === 'audio') return null;
  let w = compW;
  let h = compH;
  if (item.kind === 'motion-graphic' || item.kind === 'text') {
    const dw = item.width ?? 1920;
    const dh = item.height ?? 1080;
    const s = Math.min(compW / dw, compH / dh);
    w = dw * s;
    h = dh * s;
  }
  const t = item.transform;
  const scale = t?.scale ?? 1;
  const sw = w * scale;
  const sh = h * scale;
  return {
    x: (compW - sw) / 2 + (((t?.x ?? 0) / 100) * compW),
    y: (compH - sh) / 2 + (((t?.y ?? 0) / 100) * compH),
    width: sw,
    height: sh,
  };
}

/** Overlap test with touching edges counting as intersection. */
export function rectsIntersect(a: RegionRect, b: RegionRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x
    && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** Visual clips visible at `frame` whose rect intersects the region
 * (skips audio clips and hidden tracks). */
export function itemsInRegion(state: TimelineState, frame: number, region: RegionRect): string[] {
  const out: string[] = [];
  for (const item of state.items) {
    if (item.kind === 'audio') continue;
    if (state.tracks?.[item.track]?.hidden) continue;
    if (trackKind(state, item.track) === 'audio') continue;
    if (!(frame >= item.startFrame && frame < item.startFrame + item.durationInFrames)) continue;
    const rect = itemRectInComposition(item, state.width, state.height);
    if (rect && rectsIntersect(region, rect)) out.push(item.id);
  }
  return out;
}

export function canvasRegionRef(region: RegionRect, frame: number, state: TimelineState): SelectionReference {
  const contained = itemsInRegion(state, frame, region);
  const f = Math.max(0, Math.round(frame));
  return {
    id: `region:${region.x},${region.y},${region.width},${region.height}@${f}`,
    name: contained.length ? `画面区域（${contained.length} 个片段）` : '画面区域',
    kind: 'canvas-region',
    metadata: {
      fps: state.fps,
      timelineId: timelineIdOf(state),
      regionX: region.x,
      regionY: region.y,
      regionWidth: region.width,
      regionHeight: region.height,
      compositionWidth: state.width,
      compositionHeight: state.height,
      containedItems: contained,
      timelineFrameStart: f,
    },
  };
}

// ── Transcript selection → reference, with keptSegments word/frame mapping ──

const TRANSCRIPT_LABEL_MAX = 12;

export function transcriptSelectionRef(
  item: TimelineItem,
  wordIdxs: number[],
  fps: number,
  timelineId?: string,
): SelectionReference | null {
  const words = item.transcript ?? [];
  const gis = [...new Set(wordIdxs)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < words.length)
    .sort((a, b) => a - b);
  if (!gis.length) return null;
  const picked = gis.map((gi) => words[gi]!);
  const text = picked.map((w) => w.text).join(isCjkText(picked.map((w) => w.text).join('')) ? '' : ' ');
  // edited-timeline frames from the SAME mapper find_transcript/markers use
  const mapper = makeWordFrameMapper(item, fps);
  let fromFrame: number | undefined;
  let toFrame: number | undefined;
  for (const gi of gis) {
    const f = mapper(gi);
    if (!f) continue; // deleted / compressed-out word — no timeline position
    fromFrame = fromFrame == null ? f.fromFrame : Math.min(fromFrame, f.fromFrame);
    toFrame = toFrame == null ? f.toFrame : Math.max(toFrame, f.toFrame);
  }
  const speakers = new Set(picked.map((w) => w.speaker).filter((s): s is string => !!s));
  const label = text.length > TRANSCRIPT_LABEL_MAX ? `${text.slice(0, TRANSCRIPT_LABEL_MAX)}…` : text;
  return {
    id: `transcript:${item.id}:${gis[0]}-${gis[gis.length - 1]}`,
    name: `“${label}”（${gis.length} 词）`,
    kind: 'transcript-selection',
    metadata: {
      fps,
      ...(timelineId ? { timelineId } : {}),
      itemId: item.id,
      selectedText: text,
      selectedWordIds: gis,
      selectedWords: picked.map((w) => ({ text: w.text, start: w.start, end: w.end })),
      sourceMediaStartMs: Math.min(...picked.map((w) => w.start)),
      sourceMediaEndMs: Math.max(...picked.map((w) => w.end)),
      ...(fromFrame != null ? { timelineFrameStart: fromFrame } : {}),
      ...(toFrame != null ? { timelineFrameEnd: toFrame } : {}),
      ...(speakers.size === 1 ? { speakerName: speakerLabel([...speakers][0]) } : {}),
    },
  };
}

/** Native DOM text selection over `.cc-tx-word[data-gi]` spans → transcript
 * reference for the section (clip) the selection started in (sections carry
 * id="cc-tx-sec-{itemId}"). Clears the DOM selection on success. */
export function transcriptRefFromDomSelection(
  root: HTMLElement,
  clips: TimelineItem[],
  fps: number,
): SelectionReference | null {
  const domSel = window.getSelection();
  if (!domSel || domSel.isCollapsed || domSel.rangeCount === 0) return null;
  const range = domSel.getRangeAt(0);
  const spans = Array.from(root.querySelectorAll<HTMLElement>('.cc-tx-word[data-gi]'))
    .filter((el) => range.intersectsNode(el));
  if (!spans.length) return null;
  const section = spans[0]!.closest('section[id^="cc-tx-sec-"]');
  const clipId = section?.id.slice('cc-tx-sec-'.length);
  const clip = clipId ? clips.find((c) => c.id === clipId) : undefined;
  if (!clip) return null;
  const wordIdxs = spans
    .filter((el) => el.closest('section') === section)
    .map((el) => Number(el.dataset.gi))
    .filter((n) => Number.isFinite(n));
  const ref = transcriptSelectionRef(clip, wordIdxs, fps);
  if (ref) domSel.removeAllRanges();
  return ref;
}

// ── selection-mode store + pick event bus ────────────────────────────────────
// The composer toggle drives the flag; Timeline/Preview/Transcript read it via
// useSelectionRefMode() and report picks with emitSelectionRef(). This uses an
// isSelectionMode flag + window "openchatcut:*" CustomEvents and avoids
// prop-drilling through LibraryPanel (transcript panel lives inside it).

let selectionModeOn = false;
const modeSubs = new Set<() => void>();

export function setSelectionRefMode(on: boolean): void {
  if (selectionModeOn === on) return;
  selectionModeOn = on;
  for (const cb of modeSubs) cb();
}

const subscribeMode = (cb: () => void): (() => void) => {
  modeSubs.add(cb);
  return () => { modeSubs.delete(cb); };
};
const getMode = (): boolean => selectionModeOn;

/** Reactive selection-mode flag for panels. */
export function useSelectionRefMode(): boolean {
  return useSyncExternalStore(subscribeMode, getMode);
}

const PICK_EVENT = 'cc:selection-ref';

/** A panel picked something in selection mode → hand it to the chat composer. */
export function emitSelectionRef(ref: SelectionReference): void {
  window.dispatchEvent(new CustomEvent<SelectionReference>(PICK_EVENT, { detail: ref }));
}

export function onSelectionRef(handler: (ref: SelectionReference) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<SelectionReference>).detail);
  window.addEventListener(PICK_EVENT, listener);
  return () => window.removeEventListener(PICK_EVENT, listener);
}
