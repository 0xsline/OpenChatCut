// Timeline domain model. Deliberately small; mirrors the shape ChatCut's
// agent tools operate on (items with frame positions on named tracks).

import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';

export type TrackId = 'V2' | 'V1' | 'A1' | 'A2';
export const TRACK_ORDER: TrackId[] = ['V2', 'V1', 'A1', 'A2'];

/** An imported media file in the project's media pool (source: S3 asset). */
export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  src: string; // same-origin path under /media/uploads
  durationInFrames: number;
  width?: number;
  height?: number;
}

/** per-clip color/blur adjustments (CSS filter) — source 特效(blur)/LUT(color) */
export interface ClipFilters {
  /** 1 = normal */
  brightness?: number;
  contrast?: number;
  saturate?: number;
  /** gaussian blur radius in px (0 = none) */
  blur?: number;
}

/** one sparse reframe keyframe (source ReframeCurveV1: named scalar channels) */
export interface ReframeKeyframe {
  /** effect-local frame */
  frame: number;
  /** 0..1 composition-normalized focal point */
  focalPointX: number;
  focalPointY: number;
  /** zoom magnification at this keyframe (0.05..16) */
  magnification: number;
}

/** source ReframeCurveV1 — the only real sparse-keyframe model (zoom focal/mag) */
export interface ReframeCurveV1 {
  version: 1;
  timebase: 'effect-frame';
  coordinateSpace: 'composition-normalized';
  keyframes: ReframeKeyframe[];
}

/** source builtin:zoom — parametric animated zoom (shape curve) or a reframe curve */
export type ZoomShape = 'hold' | 'punch' | 'slow-push' | 'instant';
export interface ZoomEffect {
  /** peak magnification (source 1..16, default 1.5) */
  magnification?: number;
  /** 0..1 focal point the zoom pushes toward */
  focalPointX?: number;
  focalPointY?: number;
  shape?: ZoomShape;
  easeInFrames?: number;
  easeOutFrames?: number;
  /** sparse keyframes (source __chatcutReframeCurve); overrides the shape curve */
  reframeCurve?: ReframeCurveV1;
}

/** per-clip visual transform (scale/position/rotation) — source 缩放 tab */
export interface ClipTransform {
  /** 1 = 100% */
  scale?: number;
  /** horizontal offset as percent of canvas width (-100..100) */
  x?: number;
  /** vertical offset as percent of canvas height (-100..100) */
  y?: number;
  /** rotation in degrees */
  rotation?: number;
}

export interface TimelineItem {
  id: string;
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
  name: string;
  kind: 'motion-graphic' | 'audio' | 'video' | 'image' | 'text';
  // motion-graphic fields:
  templateId?: string;
  code?: string;
  props?: Record<string, unknown>;
  /** natural box size the template designs against */
  width?: number;
  height?: number;
  // audio / video / image source:
  src?: string;
  /** 0..1 playback volume (default 1) — audio + video */
  volume?: number;
  /** source in-point (frames) for video/audio trimming — left-trim advances it */
  srcInFrame?: number;
  /** fade in/out durations (frames): opacity ramp for visual clips, volume ramp
   * for audio (source edit_item fade, stored in seconds → frames). */
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** static transform for visual clips (source 缩放/transform: scale, position, rotate) */
  transform?: ClipTransform;
  /** color/blur adjustments for visual clips (source 特效/LUT) */
  filters?: ClipFilters;
  /** animated zoom (source builtin:zoom) — shape curve or reframe keyframes */
  zoom?: ZoomEffect;
  /** transcript-based editing: the clip's words + which are deleted (by index).
   * durationInFrames reflects the EDITED length (kept words only). */
  transcript?: TranscriptWord[];
  deletedWordIdx?: number[];
  /** clean_script silence compression: cap inter-word pauses to this many frames
   * (undefined = keep every pause at its recorded length). */
  silenceFrames?: number;
}

/** how 16:9-designed content adapts when the canvas ratio changes (source `fit`) */
export type AspectFit = 'contain' | 'cover';

export interface AspectPreset {
  label: string;
  width: number;
  height: number;
}

/** canvas ratios for long-to-short retargeting (source manage_timelines `ratio`) */
export const ASPECT_PRESETS: AspectPreset[] = [
  { label: '16:9', width: 1920, height: 1080 },
  { label: '9:16', width: 1080, height: 1920 },
  { label: '1:1', width: 1080, height: 1080 },
  { label: '4:3', width: 1440, height: 1080 },
  { label: '3:4', width: 1080, height: 1440 },
];

/** per-track visibility/audio flags (source edit_track: visible / mute) */
export interface TrackFlags {
  /** hidden track is fully disabled — its items render neither picture nor sound */
  hidden?: boolean;
  /** muted track keeps its picture but produces no audio */
  muted?: boolean;
}

/** source transition builtin ids (subset of the 12 video transitions) */
export type TransitionType =
  | 'cross-dissolve'
  | 'dip-to-black'
  | 'soft-wipe'
  | 'whip-pan'
  | 'flash'
  | 'luma-blend';

export type TransitionDirection = 'left' | 'right' | 'up' | 'down';

/** an independent transition item straddling the cut between two adjacent
 * same-track clips (source transition_item: outgoing→incoming). */
export interface TransitionItem {
  id: string;
  type: TransitionType;
  /** transition length in frames (half retreats into outgoing, half into incoming) */
  durationInFrames: number;
  outgoingItemId: string;
  incomingItemId: string;
  trackId: TrackId;
  enabled?: boolean;
  /** direction for wipe/whip transitions (default 'left') */
  direction?: TransitionDirection;
}

/** source marker palette (8 named colors → tailwind-500 hex) */
export type MarkerColor = 'blue' | 'cyan' | 'fuchsia' | 'green' | 'pink' | 'purple' | 'red' | 'yellow';
export const MARKER_HEX: Record<MarkerColor, string> = {
  blue: '#3b82f6', cyan: '#06b6d4', fuchsia: '#d946ef', green: '#10b981',
  pink: '#ec4899', purple: '#8b5cf6', red: '#ef4444', yellow: '#f59e0b',
};

/** a timeline annotation (source manage_markers): point (durationFrames 0) or
 * range (>0), anchored to the ruler (scope 'project') or a clip (scope 'item'). */
export interface Marker {
  id: string;
  scope: 'project' | 'item';
  itemId?: string; // scope 'item' only
  fromFrame: number;
  durationFrames: number;
  note: string;
  color: MarkerColor;
}

/** one timeline/sequence within a project (source: a project holds many timelines).
 * A Timeline IS a TimelineState plus identity — so every component that consumes
 * a TimelineState keeps working when handed the active timeline. */
export interface Timeline extends TimelineState {
  id: string;
  name: string;
  /** tab order (ascending) */
  order: number;
}

/** a project = an ordered set of timelines + which one is active (source
 * manage_timelines). Persisted per project; the active timeline is what the
 * editor/composition/export operate on. */
export interface ProjectDoc {
  timelines: Timeline[];
  activeTimelineId: string;
}

/** the active timeline of a project (falls back to the first if the id is stale). */
export function activeTimeline(doc: ProjectDoc): Timeline {
  return doc.timelines.find((t) => t.id === doc.activeTimelineId) ?? doc.timelines[0];
}

/** short ratio badge for a canvas size, e.g. 1920×1080 → "16:9". */
export function ratioLabel(width: number, height: number): string {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(width, height) || 1;
  return `${width / d}:${height / d}`;
}

export interface TimelineState {
  fps: number;
  width: number;
  height: number;
  /** how items fit when the canvas ratio differs from their design box */
  fit?: AspectFit;
  items: TimelineItem[];
  /** per-track hide/mute (keyed by TrackId; absent = both false) */
  tracks?: Partial<Record<TrackId, TrackFlags>>;
  /** transitions between adjacent same-track clips (source transition_item) */
  transitions?: TransitionItem[];
  /** timeline annotations / TODO anchors (source manage_markers) */
  markers?: Marker[];
  /** imported media pool ("我的素材") */
  assets?: MediaAsset[];
  selectedId: string | null;
  /** captions overlay (字幕), rendered on top + burned into export */
  captions?: CaptionsData | null;
}

/** total timeline length = last item's end (min 1s). */
export function timelineDuration(s: TimelineState): number {
  const end = s.items.reduce((m, it) => Math.max(m, it.startFrame + it.durationInFrames), 0);
  return Math.max(end, s.fps);
}

/** first free frame on a track (append point). */
export function trackEnd(s: TimelineState, track: TrackId): number {
  return s.items
    .filter((it) => it.track === track)
    .reduce((m, it) => Math.max(m, it.startFrame + it.durationInFrames), 0);
}
