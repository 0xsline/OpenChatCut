// Timeline domain model. Deliberately small — the shape the
// agent tools operate on (items with frame positions on named tracks).

import type { CaptionsData } from '../captions/types.js';
import type { SerializableFxDef } from '../gl/fx/uniforms.js';
import type { TranscriptCarrier, TranscriptVariant } from '../transcript/types.js';
import type { CURRENT_PROJECT_VERSION } from '../../shared/project-version.js';

/** Stable track id. Human aliases (C1/V1/A1/...) are derived from track order. */
export type TrackId = string;
export type TrackKind = 'video' | 'audio' | 'caption';
export type TrackRole = 'anchor' | 'follower';
export const TRACK_ORDER: TrackId[] = ['V2', 'V1', 'A1', 'A2'];

/** An imported media file in the project's media pool. */
export type MediaAssetKind = 'video' | 'image' | 'audio' | 'motion-graphic' | 'gif' | 'svg';

/** ingest-time ASR state on a pool asset ("upload and transcribe": transcribe is automatically triggered after ingest is dropped from the library,
 * asset marked "Transscription completed/failed"). Drives the media-pool badge + track_progress readiness. */
export type AssetTranscribeStatus = 'running' | 'done' | 'failed';

/** Exact frame rate used by source clocks (for example 30000/1001). */
export interface RationalFrameRate {
  numerator: number;
  denominator: number;
}

/**
 * Parsed source clock. `frameCount` is the normalized physical frame count;
 * `dropFrame` records how the human-readable label was encoded.
 */
export interface SourceClockMetadata {
  frameCount: number;
  frameRate: RationalFrameRate;
  dropFrame: boolean;
}

export interface MediaAsset extends TranscriptCarrier {
  id: string;
  name: string;
  /** Immutable filename captured from the source before internal UUID renaming. */
  readonly sourceFilename?: string;
  /** Desktop-only absolute source path used for NLE relinking; absent on web/mobile/generated media. */
  readonly originalFilePath?: string;
  kind: MediaAssetKind;
  src: string; // same-origin path under /media/uploads
  durationInFrames: number;
  /** Stable identity of the source bytes/representation used by derivatives. */
  sourceRevision?: string;
  /**
   * Canonical lowercase SHA-256 of the imported master bytes when known.
   * It deliberately remains the master identity when `src` points at a compatibility proxy or normalized derivative.
   */
  sourceContentHash?: string;
  /** File metadata used to deterministically derive sourceRevision when available. */
  sourceSize?: number;
  sourceModifiedAt?: number;
  /** Embedded source timecode normalized at ingest. */
  sourceTimecode?: SourceClockMetadata;
  /** Capture-device clock normalized at ingest when source timecode is absent. */
  captureClock?: SourceClockMetadata;
  width?: number;
  height?: number;
  code?: string;
  props?: Record<string, unknown>;
  /** media-pool organization only; does not affect timeline clips */
  folderId?: string;
  favorite?: boolean;
  /** Source revision captured when the current transcript was committed. */
  transcriptSourceRevision?: string;
  /** ingest ASR state; undefined = never transcribed (image/no-audio or pre-ingest). */
  transcribeStatus?: AssetTranscribeStatus;
  /** last ASR failure reason (transcribeStatus='failed'), for the pool badge tooltip. */
  transcribeError?: string;
}

/** Source replacement metadata. Presence of optional keys distinguishes preserve from explicit clearing. */
export interface MediaAssetRelinkPatch {
  src: string;
  name?: string;
  durationInFrames?: number;
  width?: number;
  height?: number;
  kind?: MediaAsset['kind'];
  sourceRevision?: string;
  sourceContentHash?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
  sourceFilename?: string;
  originalFilePath?: string;
}

/** user-created media-pool bin (manage_media_pool). Root is implicit. */
export interface MediaFolder {
  id: string;
  name: string;
  parentId?: string;
}

/** per-clip color/blur adjustments (CSS filter) — special effects (blur)/LUT(color) */
export interface ClipFilters {
  /** 1 = normal */
  brightness?: number;
  contrast?: number;
  saturate?: number;
  /** gaussian blur radius in px (0 = none) */
  blur?: number;
}

/** one sparse reframe keyframe (ReframeCurveV1: named scalar channels) */
export interface ReframeKeyframe {
  /** effect-local frame */
  frame: number;
  /** 0..1 composition-normalized focal point */
  focalPointX: number;
  focalPointY: number;
  /** zoom magnification at this keyframe (0.05..16) */
  magnification: number;
}

/** ReframeCurveV1 — the sparse-keyframe model for zoom (focal/mag) */
export interface ReframeCurveV1 {
  version: 1;
  timebase: 'effect-frame';
  coordinateSpace: 'composition-normalized';
  keyframes: ReframeKeyframe[];
}

/** builtin:zoom — parametric animated zoom (shape curve) or a reframe curve */
export type ZoomShape =
  | 'hold' | 'punch' | 'slow-push' | 'instant' | 'zoom-out' | 'ease-in' | 'bounce'
  | 'snap' | 'pulse' | 'whip-in';
// zh labels: 4 base curves + extended library curves
export const ZOOM_SHAPE_LABELS: Record<ZoomShape, string> = {
  punch: '冲击',
  hold: '推进拉回',
  'slow-push': '慢推',
  instant: '瞬时',
  'zoom-out': '拉远',
  'ease-in': '缓入推近',
  bounce: '弹性推近',
  snap: '快切推近',
  pulse: '心跳脉冲',
  'whip-in': '甩入推近',
};
/** library display order */
export const ZOOM_SHAPE_ORDER: readonly ZoomShape[] = [
  'punch', 'hold', 'slow-push', 'instant', 'zoom-out', 'ease-in', 'bounce',
  'snap', 'pulse', 'whip-in',
];
export interface ZoomEffect {
  /** peak magnification (1..16, default 1.5) */
  magnification?: number;
  /** 0..1 focal point the zoom pushes toward */
  focalPointX?: number;
  focalPointY?: number;
  shape?: ZoomShape;
  easeInFrames?: number;
  easeOutFrames?: number;
  /** sparse keyframes (__openchatcutReframeCurve); overrides the shape curve */
  reframeCurve?: ReframeCurveV1;
  /** Plugin scaling curve: 0..1 (can reach 1.5 overshoot) envelope, linear sampling of the entire clip.
   * Priority: reframeCurve > envelope > shape. */
  envelope?: number[];
  /** Plugin curve display name (script/inspector); used when there is no shape */
  label?: string;
}

/** easing of a generic keyframe SEGMENT (this keyframe → the next): named CSS
 * curves or a cubic-bezier control tuple [x1,y1,x2,y2]. Default linear.
 * (PRD §4.5 "bezier easing"; storage format is customized.) */
export type KeyframeEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | [number, number, number, number];

/** one generic transform keyframe. `frame` is the item-LOCAL edited frame
 * (0 = clip start), so keyframes travel with the clip when it moves. */
export interface Keyframe {
  frame: number;
  value: number;
  easing?: KeyframeEasing;
}

/** keyframable properties (PRD §4.5: Position/scale/transparency/rotation can be K frames; volume is the audio/video volume envelope) */
export type KeyframeProp = 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity' | 'borderRadius' | 'volume';
/** per-prop sparse keyframe curves on an item (sorted by frame — reducer invariant) */
export type ItemKeyframes = Partial<Record<KeyframeProp, Keyframe[]>>;

/** fractional layer-crop insets (each 0..1; left+right < 1, top+bottom < 1).
 * Rendered as clip-path inset BEFORE translate/rotate/scale, so the cropped
 * window then moves/scales as one unit — named layouts (apply_layout) rely on
 * exactly this composition order. */
export interface ClipCrop {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

/** per-clip visual transform (scale/position/rotation) — scale tab */
export interface ClipTransform {
  /** Uniform scale 1 = 100%. Fallback when scaleX/scaleY are unset. */
  scale?: number;
  /** Horizontal scale 1 = 100%. Overrides `scale` on the X axis when set. */
  scaleX?: number;
  /** Vertical scale 1 = 100%. Overrides `scale` on the Y axis when set. */
  scaleY?: number;
  /** horizontal offset as percent of canvas width (-100..100) */
  x?: number;
  /** vertical offset as percent of canvas height (-100..100) */
  y?: number;
  /** rotation in degrees */
  rotation?: number;
  /** static layer opacity (0..1); keyframed opacity overrides this value */
  opacity?: number;
  /** clipped layer corner radius in composition pixels */
  borderRadius?: number;
  /** crop the full-canvas layer to a sub-rect (split-screen / for PiP) */
  crop?: ClipCrop;
}

/** one per-clip WebGL effect instance (effects[] entry with an assetId
 * + property overrides). assetId keys the FX registry (src/gl/fx/effects.ts);
 * overrides map property name → value (clamped to the effect's range at render). */
export type ClipEffectValue = number | number[];

export interface ClipEffect {
  id: string;
  assetId: string;
  overrides?: Record<string, ClipEffectValue>;
}

export interface TimelineItem extends TranscriptCarrier {
  id: string;
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
  name: string;
  kind: 'motion-graphic' | 'audio' | 'video' | 'image' | 'text' | 'gif' | 'svg' | 'solid' | 'sequence';
  // motion-graphic fields:
  templateId?: string;
  code?: string;
  props?: Record<string, unknown>;
  /** natural box size the template designs against */
  width?: number;
  height?: number;
  // audio / video / image / gif / svg source:
  src?: string;
  /** Immutable source identity copied from the pool asset so clips survive pool removal. */
  readonly sourceFilename?: string;
  /** Desktop-only absolute source path; never exposed through agent read APIs or portable packages. */
  readonly originalFilePath?: string;
  /** Stable media-pool identity; unlike src, this remains unambiguous across duplicates and relinks. */
  sourceAssetId?: string;
  /** Revision copied from the pool asset when this clip was placed or relinked. */
  sourceRevision?: string;
  /** Source byte identity copied from the pool asset for detached clip snapshots. */
  sourceContentHash?: string;
  /** Nested sequence reference. Required when kind='sequence'; absent on legacy items. */
  timelineId?: string;
  /** Persistent multicam membership; copied by split so angle identity survives edits. */
  multicamGroupId?: string;
  multicamAngleId?: string;
  /** 0..1 playback volume (default 1) — audio + video */
  volume?: number;
  /** source in-point (frames) for video/audio trimming or a nested sequence source window */
  srcInFrame?: number;
  /** fade in/out durations (frames): opacity ramp for visual clips, volume ramp
   * for audio (edit_item fade, stored in seconds → frames). */
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** static transform for visual clips (scale/transform: scale, position, rotate) */
  transform?: ClipTransform;
  /** generic transform keyframes (PRD §4.5 Pen tool): per-prop curves in item-local
   * edit frames. A keyframed prop overrides its static transform value; opacity
   * multiplies onto fades. Visual clips only. */
  keyframes?: ItemKeyframes;
  /** color/blur adjustments for visual clips (special effects/LUT) */
  filters?: ClipFilters;
  /** blurred cover copy behind the contained clip */
  backgroundFill?: boolean;
  /** user-selected background blur/dimming intensity, 0..100 percent */
  backgroundFillStrength?: number;
  /** animated zoom (builtin:zoom) — shape curve or reframe keyframes */
  zoom?: ZoomEffect;
  /** per-clip WebGL effect stack (effects[]: builtin:fx-* / lut) */
  effects?: ClipEffect[];
  /** Playback speed: 1 = normal, 2 = 2× faster. Retiming keeps the source span,
   * so durationInFrames scales by 1/rate. Applies to video/audio/sequence items. */
  playbackRate?: number;
  deletedWordIdx?: number[];
  /** text-only translation / correction variants of `transcript`. Each keys words
   * by their SOURCE index and carries only text — timing always comes from the
   * source word, so a variant never re-times a clip. Captions pick which
   * to display via CaptionsData.captionVariantId. */
  variants?: TranscriptVariant[];
  /** clean_script silence compression: cap inter-word pauses to this many frames
   * (undefined = keep every pause at its recorded length). */
  silenceFrames?: number;
  /** clean_script Breathing port: A total of so many frames of original silence are retained on both sides of the word deletion cutout (both sides are divided equally),
   * Prevent the cut from hitting the word boundary and cutting off the consonants. undefined/0 = cut exactly at word boundaries. */
  cutPadFrames?: number;
  /**
   * Per-gap silence caps (transcript Gap row / delete-gap).
   * Key = word index AFTER the gap (string for JSON); value = max allowed gap ms
   * (0 = delete that breath/gap). Overrides silenceFrames for that boundary only.
   */
  gapCapsMs?: Record<string, number>;
  /**
   * Playback order of SOURCE word indices (drag-reorder speech blocks in transcript).
   * undefined = chronological 0..n-1. Indices still refer to `transcript[]` slots
   * (variants / gapCaps stay valid). Playback concatenates ranges in this order.
   */
  transcriptPlayOrder?: number[];
  /**
   * AI Voice Isolation (isolate_voice / DeepFilterNet3).
   * `src` stays the original media; playback uses denoisedSrc for audio when set.
   */
  denoisedSrc?: string | null;
  /** isolation strength 0–100 (atten-lim-db), default 100 */
  denoiseStrength?: number | null;
}

export type TimelineLinkMode = 'linked' | 'sync-lock';

/** Linked A/V or sync-lock membership. Offsets are defined by the anchor item. */
export interface TimelineLinkGroup {
  id: string;
  itemIds: string[];
  anchorItemId: string;
  mode: TimelineLinkMode;
}

export type MulticamMicRole = 'program' | 'reference' | 'camera' | 'scratch' | 'none';
export type MulticamSyncMethod = 'source-timecode' | 'capture-clock' | 'audio';

export interface MulticamSyncEvidence {
  angleId: string;
  method: MulticamSyncMethod;
  confidence: number;
  offsetFrames: number;
  referenceClockFrame?: number;
  angleClockFrame?: number;
  lagSeconds?: number;
}

export interface MulticamAngle {
  id: string;
  /** Current/original item id; split descendants retain id via multicamAngleId. */
  itemId: string;
  /** Immutable aligned source snapshot used to restore a previously switched-out range. */
  source: TimelineItem;
  label: string;
  micRole?: MulticamMicRole;
  offsetFrames: number;
  confidence: number;
}

/** One non-destructive editorial decision over a right-open timeline range. */
export interface MulticamAngleDecision {
  id: string;
  fromFrame: number;
  toFrame: number;
  angleId: string;
}

export interface MulticamGroup {
  id: string;
  referenceAngleId: string;
  masterAngleId: string;
  angles: MulticamAngle[];
  syncMethod: MulticamSyncMethod;
  evidence: MulticamSyncEvidence[];
  decisions?: MulticamAngleDecision[];
}

/** how 16:9-designed content adapts when the canvas ratio changes (`fit`) */
export type AspectFit = 'contain' | 'cover';

export interface AspectPreset {
  label: string;
  width: number;
  height: number;
}

/** canvas ratios for long-to-short retargeting (manage_timelines `ratio`) */
export const ASPECT_PRESETS: AspectPreset[] = [
  { label: '16:9', width: 1920, height: 1080 },
  { label: '9:16', width: 1080, height: 1920 },
  { label: '1:1', width: 1080, height: 1080 },
  { label: '4:3', width: 1440, height: 1080 },
  { label: '3:4', width: 1080, height: 1440 },
];

/** per-track state (edit_track). The map key is the stable track id. */
export interface TrackFlags {
  kind?: TrackKind;
  name?: string;
  /** Caption payload owned by this caption track. */
  captions?: CaptionsData | null;
  /** hidden track is fully disabled — its items render neither picture nor sound */
  hidden?: boolean;
  /** muted track keeps its picture but produces no audio */
  muted?: boolean;
  /** local editor controls: lock structural edits / collapse the lane
   * (collapsed = track-header collapse chevron → thin strip) */
  locked?: boolean;
  collapsed?: boolean;
  /** anchor speech triggers ducking; follower music ducks under anchors */
  role?: TrackRole;
  audioRouting?: { duckDepthDb?: number };
}

export type TrackUpdate = Partial<Omit<TrackFlags, 'kind' | 'role' | 'audioRouting' | 'captions'>> & {
  order?: number;
  role?: TrackRole | null;
  audioRouting?: { duckDepthDb?: number | null };
};

/** transitions with a CSS fallback for non-texturable DOM clips. */
export type CssTransitionType =
  | 'cross-dissolve'
  | 'dip-to-black'
  | 'soft-wipe'
  | 'whip-pan'
  | 'flash'
  | 'luma-blend';

/** these video transitions run their real GLSL for video/image clips. */
export type GlslTransitionType =
  | CssTransitionType
  | 'page-curl'
  | 'rack-focus'
  | 'organic-dissolve'
  | 'impact-shake'
  | 'anticipation-zoom'
  | 'clean-line-wipe'
  | 'circle-wipe'
  | 'radial-blur'
  | 'glitch-cut'
  | 'dip-to-color';

/** Audio-only transitions (preset `trAudioCrossFade`) — no picture. */
export type AudioTransitionType = 'audio-cross-fade';

/** builtin transition ids + extended library transitions + audio + custom shader.
 *  'custom-shader' = a submit_shader-generated transition; its two-input GLSL lives on the
 *  TransitionItem (customFrag), NOT in the exhaustive GLSL_TRANSITIONS record. */
export type TransitionType = GlslTransitionType | AudioTransitionType | 'custom-shader';

export const GLSL_TRANSITION_TYPES: ReadonlySet<string> = new Set<string>([
  'cross-dissolve', 'dip-to-black', 'soft-wipe', 'whip-pan', 'flash', 'luma-blend',
  'page-curl', 'rack-focus', 'organic-dissolve', 'impact-shake', 'anticipation-zoom', 'clean-line-wipe',
  'circle-wipe', 'radial-blur', 'glitch-cut', 'dip-to-color',
  'custom-shader', // takes the GL render path; frag comes from the item, not GLSL_TRANSITIONS
]);

export const CSS_TRANSITION_TYPES: ReadonlySet<string> = new Set<string>([
  'cross-dissolve', 'dip-to-black', 'soft-wipe', 'whip-pan', 'flash', 'luma-blend',
]);

export const AUDIO_TRANSITION_TYPES: ReadonlySet<AudioTransitionType> = new Set<AudioTransitionType>([
  'audio-cross-fade',
]);

export function isAudioTransition(type: TransitionType): type is AudioTransitionType {
  return AUDIO_TRANSITION_TYPES.has(type as AudioTransitionType);
}

export function isVisualTransition(type: TransitionType): type is GlslTransitionType {
  return !isAudioTransition(type);
}

// en labels for the transition library cards (Resource Library·Transition·Screen Transition).
// Shared by the inspector select + the resource-library grid.
export const TRANSITION_LABELS: Record<TransitionType, string> = {
  'anticipation-zoom': '推进转场',
  'clean-line-wipe': '白色划线转场',
  'cross-dissolve': '叠化转场',
  'dip-to-black': '闪黑转场',
  flash: '闪白转场',
  'impact-shake': '冲击抖动转场',
  'luma-blend': '叠加转场',
  'organic-dissolve': '光溶转场',
  'page-curl': '翻页转场',
  'rack-focus': '焦点转场',
  'soft-wipe': '柔化擦除转场',
  'whip-pan': '甩镜转场',
  'circle-wipe': '圆形擦除转场',
  'radial-blur': '径向模糊转场',
  'glitch-cut': '故障切换转场',
  'dip-to-color': '闪色转场',
  /** preset.name.trAudioCrossFade */
  'audio-cross-fade': '音频交叉淡化',
  /** submit_shader-generated custom transition (per-item label in customLabel) */
  'custom-shader': '自定义着色器转场',
};

/** catalog display order + extended visual transitions. */
export const TRANSITION_ORDER: readonly GlslTransitionType[] = [
  'anticipation-zoom',
  'clean-line-wipe',
  'cross-dissolve',
  'dip-to-black',
  'flash',
  'impact-shake',
  'luma-blend',
  'organic-dissolve',
  'page-curl',
  'rack-focus',
  'soft-wipe',
  'whip-pan',
  'circle-wipe',
  'radial-blur',
  'glitch-cut',
  'dip-to-color',
];

/** Audio transition catalog (trAudioCrossFade). */
export const AUDIO_TRANSITION_ORDER: readonly AudioTransitionType[] = [
  'audio-cross-fade',
];

export type TransitionDirection = 'left' | 'right' | 'up' | 'down';

/** an independent transition item straddling the cut between two adjacent
 * same-track clips (transition_item: outgoing→incoming). */
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
  /** type='custom-shader' only: the submit_shader-generated two-input transition GLSL,
   *  stored here (not in a registry) so it persists with the project and renders after
   *  reload. customUniforms = {u_<key>: value}; customLabel = display name. */
  customFrag?: string;
  customUniforms?: Record<string, number>;
  customLabel?: string;
}

/** marker palette (8 named colors → tailwind-500 hex) */
export type MarkerColor = 'blue' | 'cyan' | 'fuchsia' | 'green' | 'pink' | 'purple' | 'red' | 'yellow';
export const MARKER_HEX: Record<MarkerColor, string> = {
  blue: '#3b82f6', cyan: '#06b6d4', fuchsia: '#d946ef', green: '#10b981',
  pink: '#ec4899', purple: '#8b5cf6', red: '#ef4444', yellow: '#f59e0b',
};

/** a timeline annotation (manage_markers): point (durationFrames 0) or
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

/** one timeline/sequence within a project (a project holds many timelines).
 * A Timeline IS a TimelineState plus identity — so every component that consumes
 * a TimelineState keeps working when handed the active timeline. */
export interface Timeline extends TimelineState {
  id: string;
  name: string;
  /** tab order (ascending) */
  order: number;
  /** hidden tab (manage_timelines update.hidden): data kept, tab not shown */
  hidden?: boolean;
}

/** design style = the project's brand identity (manage_design_style).
 * The applied style IS the brand — there is no separate "project brand" — and it
 * drives the colors + fonts the agent uses when generating MG / captions.
 *
 * ROLES ARE FREE-FORM (verified against the live `/design-styles/catalog`): real
 * styles use descriptive role names like "accent copper", "text secondary",
 * "Chinese heading", "blob warm", "chart accent 1". The lists below are only the
 * canonical roles the editor UI labels + the keys the legacy object form maps. */
export type ColorRole = string;
export type FontRole = string;
/** canonical color roles the editor surfaces as labelled rows (`Ey`). */
export const COLOR_ROLES: readonly string[] = ['primary', 'secondary', 'accent', 'background', 'text'];
/** canonical font roles the editor surfaces as labelled rows (`Ay`). */
export const FONT_ROLES: readonly string[] = ['heading', 'body'];

export interface DesignColor { role: string; value: string; }
export interface DesignFont { family: string; role: string; }
export interface DesignStyle {
  colors: DesignColor[];
  fonts: DesignFont[];
  /** Project editing guidance for color, typography, captions, pacing, motion,
   * transitions, and explicit avoid rules. */
  styleGuide?: string;
}

/** value of a color role in a style (undefined if the role is unset). */
export const colorOf = (s: DesignStyle | undefined, role: string): string | undefined =>
  s?.colors.find((c) => c.role === role)?.value;
/** font family for a role in a style (undefined if unset). */
export const fontOf = (s: DesignStyle | undefined, role: string): string | undefined =>
  s?.fonts.find((f) => f.role === role)?.family;

/** a project = shared media + ordered timelines + which one is active
 * (manage_timelines). `version` makes persisted-document migrations explicit. */
export interface ProjectDoc {
  version: typeof CURRENT_PROJECT_VERSION;
  /** project-wide media pool, shared by every timeline */
  assets: MediaAsset[];
  mediaFolders: MediaFolder[];
  timelines: Timeline[];
  activeTimelineId: string;
  /** applied brand identity (manage_design_style); absent = no style set */
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

/** text watermark overlay (updateWatermark — in-app behavior, no precise signature,
 * shape (custom shape). A generic brand overlay burned into preview + export;
 * default disabled, NOT a paywall/free-tier gimmick. */
export type WatermarkPosition = 'tl' | 'tr' | 'bl' | 'br';
export interface Watermark {
  enabled: boolean;
  text: string;
  position: WatermarkPosition;
  /** 0..1 overlay opacity */
  opacity: number;
}
export const DEFAULT_WATERMARK: Watermark = { enabled: false, text: '', position: 'br', opacity: 0.7 };

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
  /** transitions between adjacent same-track clips (transition_item) */
  transitions?: TransitionItem[];
  /** timeline annotations / TODO anchors (manage_markers) */
  markers?: Marker[];
  /** Optional professional edit relationships; absent in legacy projects. */
  linkGroups?: TimelineLinkGroup[];
  /** Persistent multicam sources, sync evidence and range camera decisions. */
  multicamGroups?: MulticamGroup[];
  /** Derived compatibility view of ProjectDoc.assets; never persisted here */
  assets?: MediaAsset[];
  /** Global caption-system visibility (captions off also hides on-screen text
   * clips). When absent, derive from caption tracks being all disabled. */
  captionsHidden?: boolean;
  /** Primary selection (last clicked) — inspector / single-item ops. */
  selectedId: string | null;
  /**
   * Multi-select set (⌘A / ⌘click / ⇧click).
   * Always kept in sync with selectedId: primary is the last id in the list.
   * Older docs may omit this; use `selectedIdsOf()`.
   */
  selectedIds?: string[];
  /** captions overlay (captions), rendered on top + burned into export*/
  captions?: CaptionsData | null;
  /** text watermark overlay (updateWatermark), rendered on top + burned into export */
  watermark?: Watermark;
  /** Serializable def of non-built-in fx (plugin/submit_shader), stored by assetId. Snapshot when applying effects,
   * TimelineComposition is registered in ALL_FX before rendering - refresh and headless export are therefore self-contained.*/
  fxDefs?: Record<string, SerializableFxDef>;
}

/** Track ids in visual top-to-bottom order. Legacy four-lane states still work. */
export function timelineTrackIds(s: TimelineState): TrackId[] {
  const ids = s.trackOrder ? [...s.trackOrder] : [...TRACK_ORDER];
  for (const id of Object.keys(s.tracks ?? {})) if (!ids.includes(id)) ids.push(id);
  for (const item of s.items) if (!ids.includes(item.track)) ids.push(item.track);
  return ids;
}

export function trackKind(s: TimelineState, id: TrackId): TrackKind {
  const prefix = id.toUpperCase()[0];
  return s.tracks?.[id]?.kind ?? (prefix === 'A' ? 'audio' : prefix === 'C' ? 'caption' : 'video');
}

/** Current human alias. Video aliases count bottom-up; audio/caption aliases top-down. */
export function trackAlias(s: TimelineState, id: TrackId): string {
  const ids = timelineTrackIds(s);
  const kind = trackKind(s, id);
  const same = ids.filter((candidate) => trackKind(s, candidate) === kind);
  const index = same.indexOf(id);
  if (index < 0) return id;
  if (kind === 'video') return `V${same.length - index}`;
  return `${kind === 'caption' ? 'C' : 'A'}${index + 1}`;
}

/** Resolve either a stable id or current Cn/Vn/An alias. */
export function resolveTrackId(s: TimelineState, ref: unknown, kind?: TrackKind): TrackId | null {
  const value = String(ref ?? '').trim();
  const ids = timelineTrackIds(s).filter((id) => !kind || trackKind(s, id) === kind);
  if (ids.includes(value)) return value;
  const upper = value.toUpperCase();
  return ids.find((id) => trackAlias(s, id) === upper) ?? null;
}

/** Default placement lane: V1 (bottom video) or A1 (top audio). */
/** Selected clip ids (multi-select aware; falls back to selectedId). */
export function selectedIdsOf(s: Pick<TimelineState, 'selectedId' | 'selectedIds'>): string[] {
  if (s.selectedIds && s.selectedIds.length) return s.selectedIds;
  return s.selectedId ? [s.selectedId] : [];
}

export function isItemSelected(s: Pick<TimelineState, 'selectedId' | 'selectedIds'>, id: string): boolean {
  return selectedIdsOf(s).includes(id);
}

/** Visual (picture) clip kinds — not pure audio. */
export function isVisualItemKind(kind: TimelineItem['kind']): boolean {
  return kind !== 'audio';
}

/** Kinds that draw from a media src (file-backed). */
export function isFileMediaKind(kind: TimelineItem['kind'] | MediaAssetKind): boolean {
  return kind === 'video' || kind === 'image' || kind === 'audio' || kind === 'gif' || kind === 'svg';
}

/** Kinds rendered via MediaFill (raster/video path). */
export function isRasterMediaKind(kind: TimelineItem['kind']): boolean {
  return kind === 'video' || kind === 'image' || kind === 'gif' || kind === 'svg';
}

export function defaultTrackId(s: TimelineState, kind: TrackKind): TrackId | null {
  const alias = kind === 'video' ? 'V1' : kind === 'caption' ? 'C1' : 'A1';
  return resolveTrackId(s, alias, kind)
    ?? timelineTrackIds(s).find((id) => trackKind(s, id) === kind)
    ?? null;
}

/** Caption data for one lane. The first caption lane falls back to legacy projects. */
export function captionsOnTrack(s: TimelineState, id: TrackId): CaptionsData | null {
  const own = s.tracks?.[id]?.captions;
  if (own !== undefined) return own;
  return id === defaultTrackId(s, 'caption') ? s.captions ?? null : null;
}

export function captionTrackEntries(s: TimelineState): Array<{ id: TrackId; captions: CaptionsData | null }> {
  return timelineTrackIds(s)
    .filter((id) => trackKind(s, id) === 'caption')
    .map((id) => ({ id, captions: captionsOnTrack(s, id) }));
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
