// Timeline domain model. Deliberately small; mirrors the shape ChatCut's
// agent tools operate on (items with frame positions on named tracks).

import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';

/** Stable track id. Human aliases (V1/A1/...) are derived from track order. */
export type TrackId = string;
export type TrackKind = 'video' | 'audio';
export type TrackRole = 'anchor' | 'follower';
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
  /** media-pool organization only; does not affect timeline clips */
  folderId?: string;
  favorite?: boolean;
}

/** user-created media-pool bin (source manage_media_pool). Root is implicit. */
export interface MediaFolder {
  id: string;
  name: string;
  parentId?: string;
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
// zh labels + order for the built-in zoom curves (shared by inspector + library)
export const ZOOM_SHAPE_LABELS: Record<ZoomShape, string> = {
  hold: '推入保持 (hold)',
  punch: '猛推 (punch)',
  'slow-push': '缓推 (slow-push)',
  instant: '瞬时 (instant)',
};
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

/** one per-clip WebGL effect instance (source: effects[] entry with an assetId
 * + property overrides). assetId keys the FX registry (src/gl/fx/effects.ts);
 * overrides map property name → value (clamped to the effect's range at render). */
export type ClipEffectValue = number | number[];

export interface ClipEffect {
  id: string;
  assetId: string;
  overrides?: Record<string, ClipEffectValue>;
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
  /** per-clip WebGL effect stack (source effects[]: builtin:fx-* / lut) */
  effects?: ClipEffect[];
  /** playback speed (source 变速/dH rate): 1 = normal, 2 = 2× faster. Retiming
   * keeps the source span, so durationInFrames scales by 1/rate. video/audio only. */
  playbackRate?: number;
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

/** per-track state (source edit_track). The map key is the stable track id. */
export interface TrackFlags {
  kind?: TrackKind;
  name?: string;
  /** hidden track is fully disabled — its items render neither picture nor sound */
  hidden?: boolean;
  /** muted track keeps its picture but produces no audio */
  muted?: boolean;
  /** local editor controls: lock structural edits / collapse the lane
   * (collapsed = source track-header collapse chevron → thin strip) */
  locked?: boolean;
  collapsed?: boolean;
  /** anchor speech triggers ducking; follower music ducks under anchors */
  role?: TrackRole;
  audioRouting?: { duckDepthDb?: number };
}

export type TrackUpdate = Partial<Omit<TrackFlags, 'kind' | 'role' | 'audioRouting'>> & {
  order?: number;
  role?: TrackRole | null;
  audioRouting?: { duckDepthDb?: number | null };
};

/** source transitions with a CSS fallback for non-texturable DOM clips. */
export type CssTransitionType =
  | 'cross-dissolve'
  | 'dip-to-black'
  | 'soft-wipe'
  | 'whip-pan'
  | 'flash'
  | 'luma-blend';

/** all source video transitions run their real GLSL for video/image clips. */
export type GlslTransitionType =
  | CssTransitionType
  | 'page-curl'
  | 'rack-focus'
  | 'organic-dissolve'
  | 'impact-shake'
  | 'anticipation-zoom'
  | 'clean-line-wipe';

/** source transition builtin ids (the 12 video transitions) */
export type TransitionType = GlslTransitionType;

export const GLSL_TRANSITION_TYPES: ReadonlySet<TransitionType> = new Set<TransitionType>([
  'cross-dissolve', 'dip-to-black', 'soft-wipe', 'whip-pan', 'flash', 'luma-blend',
  'page-curl', 'rack-focus', 'organic-dissolve', 'impact-shake', 'anticipation-zoom', 'clean-line-wipe',
]);

export const CSS_TRANSITION_TYPES: ReadonlySet<TransitionType> = new Set<TransitionType>([
  'cross-dissolve', 'dip-to-black', 'soft-wipe', 'whip-pan', 'flash', 'luma-blend',
]);

// zh labels + display order for the 12 transitions (CSS group first, then the
// real-GLSL group). Shared by the inspector select + the resource-library tab.
export const TRANSITION_LABELS: Record<TransitionType, string> = {
  'cross-dissolve': '交叉溶解',
  'dip-to-black': '黑场过渡',
  'soft-wipe': '柔化擦除',
  'whip-pan': '甩镜',
  flash: '闪白',
  'luma-blend': '亮度混合',
  'clean-line-wipe': '利落划线',
  'page-curl': '翻页',
  'rack-focus': '焦点切换',
  'organic-dissolve': '有机溶解',
  'impact-shake': '冲击震动',
  'anticipation-zoom': '蓄力推近',
};

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
  /** hidden tab (source manage_timelines update.hidden): data kept, tab not shown */
  hidden?: boolean;
}

/** design style = the project's brand identity (source manage_design_style).
 * The applied style IS the brand — there is no separate "project brand" — and it
 * drives the colors + fonts the agent uses when generating MG / captions.
 *
 * ROLES ARE FREE-FORM (verified against the live `/design-styles/catalog`): real
 * styles use descriptive role names like "accent copper", "text secondary",
 * "Chinese heading", "blob warm", "chart accent 1". The lists below are only the
 * canonical roles the editor UI labels + the keys the legacy object form maps. */
export type ColorRole = string;
export type FontRole = string;
/** canonical color roles the editor surfaces as labelled rows (source `Ey`). */
export const COLOR_ROLES: readonly string[] = ['primary', 'secondary', 'accent', 'background', 'text'];
/** canonical font roles the editor surfaces as labelled rows (source `Ay`). */
export const FONT_ROLES: readonly string[] = ['heading', 'body'];

export interface DesignColor { role: string; value: string; }
export interface DesignFont { family: string; role: string; }
export interface DesignStyle {
  colors: DesignColor[];
  fonts: DesignFont[];
  /** brand + motion guidelines (source designSpec.styleGuide — often a detailed
   * spring/stagger motion spec, not just a vibe sentence) */
  styleGuide?: string;
}

/** value of a color role in a style (undefined if the role is unset). */
export const colorOf = (s: DesignStyle | undefined, role: string): string | undefined =>
  s?.colors.find((c) => c.role === role)?.value;
/** font family for a role in a style (undefined if unset). */
export const fontOf = (s: DesignStyle | undefined, role: string): string | undefined =>
  s?.fonts.find((f) => f.role === role)?.family;

/** a project = shared media + ordered timelines + which one is active (source
 * manage_timelines). `version` makes persisted-document migrations explicit. */
export interface ProjectDoc {
  version: 2;
  /** project-wide media pool, shared by every timeline */
  assets: MediaAsset[];
  mediaFolders: MediaFolder[];
  timelines: Timeline[];
  activeTimelineId: string;
  /** applied brand identity (source manage_design_style); absent = no style set */
  designStyle?: DesignStyle;
}

/** the active timeline of a project (falls back to the first if the id is stale). */
export function activeTimeline(doc: ProjectDoc): Timeline {
  return doc.timelines.find((t) => t.id === doc.activeTimelineId) ?? doc.timelines[0];
}

/** active editor view with the project's shared assets attached for existing
 * timeline consumers. The returned `assets` field is derived, never persisted
 * inside a timeline. */
export function activeEditorState(doc: ProjectDoc): Timeline {
  return { ...activeTimeline(doc), assets: doc.assets };
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
  /** visual top-to-bottom order of stable track ids */
  trackOrder?: TrackId[];
  /** per-track metadata (keyed by stable TrackId; legacy states only have flags) */
  tracks?: Partial<Record<TrackId, TrackFlags>>;
  /** transitions between adjacent same-track clips (source transition_item) */
  transitions?: TransitionItem[];
  /** timeline annotations / TODO anchors (source manage_markers) */
  markers?: Marker[];
  /** derived compatibility view of ProjectDoc.assets; never persisted here */
  assets?: MediaAsset[];
  selectedId: string | null;
  /** captions overlay (字幕), rendered on top + burned into export */
  captions?: CaptionsData | null;
}

/** Track ids in visual top-to-bottom order. Legacy four-lane states still work. */
export function timelineTrackIds(s: TimelineState): TrackId[] {
  const ids = s.trackOrder ? [...s.trackOrder] : [...TRACK_ORDER];
  for (const id of Object.keys(s.tracks ?? {})) if (!ids.includes(id)) ids.push(id);
  for (const item of s.items) if (!ids.includes(item.track)) ids.push(item.track);
  return ids;
}

export function trackKind(s: TimelineState, id: TrackId): TrackKind {
  return s.tracks?.[id]?.kind ?? (id.toUpperCase().startsWith('A') ? 'audio' : 'video');
}

/** Current human alias. Video aliases count bottom-up; audio aliases top-down. */
export function trackAlias(s: TimelineState, id: TrackId): string {
  const ids = timelineTrackIds(s);
  const kind = trackKind(s, id);
  const same = ids.filter((candidate) => trackKind(s, candidate) === kind);
  const index = same.indexOf(id);
  if (index < 0) return id;
  return kind === 'video' ? `V${same.length - index}` : `A${index + 1}`;
}

/** Resolve either a stable id or current Vn/An alias. */
export function resolveTrackId(s: TimelineState, ref: unknown, kind?: TrackKind): TrackId | null {
  const value = String(ref ?? '').trim();
  const ids = timelineTrackIds(s).filter((id) => !kind || trackKind(s, id) === kind);
  if (ids.includes(value)) return value;
  const upper = value.toUpperCase();
  return ids.find((id) => trackAlias(s, id) === upper) ?? null;
}

/** Default placement lane: V1 (bottom video) or A1 (top audio). */
export function defaultTrackId(s: TimelineState, kind: TrackKind): TrackId | null {
  return resolveTrackId(s, kind === 'video' ? 'V1' : 'A1', kind)
    ?? timelineTrackIds(s).find((id) => trackKind(s, id) === kind)
    ?? null;
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
