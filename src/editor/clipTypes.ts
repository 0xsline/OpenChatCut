import type { TranscriptCarrier, TranscriptVariant } from '../transcript/types.js';
import type { TrackId } from './trackTypes.js';

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
