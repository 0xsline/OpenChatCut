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
const percent = (value: number) => `${Math.round(value)}%`;

export const KEYFRAME_PROPERTY_REGISTRY: Record<KeyframeProp, KeyframePropertyDefinition> = {
  scale: {
    id: 'scale', label: '缩放比例', valueRange: [0, 10], editorRange: [0.1, 3],
    step: 0.05, defaultValue: 1, supports: visual,
    getBaseValue: (item) => item.transform?.scale ?? 1,
    toTransformPatch: (scale) => ({ scale }),
    format: (value) => `${Math.round(value * 100)}%`,
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
    format: (value) => `${Math.round(value)}°`,
  },
  opacity: {
    id: 'opacity', label: '透明', valueRange: [0, 1], editorRange: [0, 1],
    step: 0.01, defaultValue: 1, supports: visual,
    getBaseValue: () => 1,
    format: (value) => `${Math.round(value * 100)}%`,
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
