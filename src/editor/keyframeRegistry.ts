import { resolveClipScaleAxes, uniformScalePatch } from './clipTransformScale';
import type { ClipTransform, KeyframeProp, TimelineItem } from './types';

export interface KeyframePropertyDefinition {
  id: KeyframeProp;
  label: string;
  valueRange: readonly [number, number];
  editorRange: readonly [number, number];
  step: number;
  defaultValue: number;
  supports: (item: TimelineItem) => boolean;
  getBaseValue: (item: TimelineItem) => number;
  toTransformPatch?: (value: number) => ClipTransform;
  format: (value: number) => string;
}

const visual = (item: TimelineItem) => item.kind !== 'audio';
const roundableVisual = (item: TimelineItem) => item.kind !== 'audio' && item.kind !== 'text';
const audible = (item: TimelineItem) => item.kind === 'audio' || item.kind === 'video';
const compact = (value: number) => String(Number(value.toFixed(2)));
const percent = (value: number) => `${compact(value)}%`;
const scaleRange = {
  valueRange: [0, 10] as const,
  editorRange: [0.1, 3] as const,
  step: 0.05,
  defaultValue: 1,
  format: (value: number) => `${compact(value * 100)}%`,
};

export const KEYFRAME_PROPERTY_REGISTRY: Record<KeyframeProp, KeyframePropertyDefinition> = {
  scale: {
    id: 'scale', label: '缩放比例', ...scaleRange, supports: visual,
    getBaseValue: (item) => {
      const { scaleX, scaleY } = resolveClipScaleAxes(item.transform);
      return Math.abs(scaleX - scaleY) < 1e-6 ? scaleX : (item.transform?.scale ?? scaleX);
    },
    // Uniform control keeps axes linked and clears prior non-uniform residue.
    toTransformPatch: (scale) => uniformScalePatch(scale),
  },
  scaleX: {
    id: 'scaleX', label: '横向缩放', ...scaleRange, supports: visual,
    getBaseValue: (item) => resolveClipScaleAxes(item.transform).scaleX,
    toTransformPatch: (scaleX) => ({ scaleX }),
  },
  scaleY: {
    id: 'scaleY', label: '纵向缩放', ...scaleRange, supports: visual,
    getBaseValue: (item) => resolveClipScaleAxes(item.transform).scaleY,
    toTransformPatch: (scaleY) => ({ scaleY }),
  },
  x: {
    id: 'x', label: '水平', valueRange: [-400, 400], editorRange: [-100, 100],
    step: 1, defaultValue: 0, supports: visual,
    getBaseValue: (item) => item.transform?.x ?? 0,
    toTransformPatch: (x) => ({ x }), format: percent,
  },
  y: {
    id: 'y', label: '垂直', valueRange: [-400, 400], editorRange: [-100, 100],
    step: 1, defaultValue: 0, supports: visual,
    getBaseValue: (item) => item.transform?.y ?? 0,
    toTransformPatch: (y) => ({ y }), format: percent,
  },
  rotation: {
    id: 'rotation', label: '旋转', valueRange: [-3600, 3600], editorRange: [-180, 180],
    step: 1, defaultValue: 0, supports: visual,
    getBaseValue: (item) => item.transform?.rotation ?? 0,
    toTransformPatch: (rotation) => ({ rotation }),
    format: (value) => `${compact(value)}°`,
  },
  opacity: {
    id: 'opacity', label: '透明', valueRange: [0, 1], editorRange: [0, 1],
    step: 0.01, defaultValue: 1, supports: visual,
    getBaseValue: (item) => item.transform?.opacity ?? 1,
    toTransformPatch: (opacity) => ({ opacity }),
    format: (value) => `${compact(value * 100)}%`,
  },
  borderRadius: {
    id: 'borderRadius', label: '圆角', valueRange: [0, 1000], editorRange: [0, 500],
    step: 1, defaultValue: 0, supports: roundableVisual,
    getBaseValue: (item) => item.transform?.borderRadius ?? 0,
    toTransformPatch: (borderRadius) => ({ borderRadius }),
    format: (value) => `${compact(value)}px`,
  },
  volume: {
    id: 'volume', label: '音量', valueRange: [0, 2], editorRange: [0, 2],
    step: 0.05, defaultValue: 1, supports: audible,
    getBaseValue: (item) => item.volume ?? 1,
    format: (value) => `${compact(value * 100)}%`,
  },
};

export const KEYFRAME_PROPS = Object.freeze(
  Object.keys(KEYFRAME_PROPERTY_REGISTRY) as KeyframeProp[],
);

export const getKeyframePropertyDefinition = (
  prop: KeyframeProp,
): KeyframePropertyDefinition => KEYFRAME_PROPERTY_REGISTRY[prop];

export const supportsKeyframeProperty = (
  item: TimelineItem,
  prop: KeyframeProp,
): boolean => KEYFRAME_PROPERTY_REGISTRY[prop].supports(item);

export function coerceKeyframeValue(prop: KeyframeProp, value: number): number {
  const [min, max] = KEYFRAME_PROPERTY_REGISTRY[prop].valueRange;
  return Math.min(max, Math.max(min, value));
}
