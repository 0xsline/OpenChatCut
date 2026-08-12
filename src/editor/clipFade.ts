import { sampleKeyframes } from './keyframes';
import type { TimelineItem } from './types';

/** Fade multiplier at a Sequence-relative frame. */
export function clipFadeFactor(
  frame: number,
  durationInFrames: number,
  fadeInFrames = 0,
  fadeOutFrames = 0,
): number {
  let factor = 1;
  if (fadeInFrames > 0) factor = Math.min(factor, frame / fadeInFrames);
  if (fadeOutFrames > 0) factor = Math.min(factor, (durationInFrames - frame) / fadeOutFrames);
  return Math.max(0, Math.min(1, factor));
}

/** Visual opacity shared by the foreground and any full-canvas companion layer. */
export function clipOpacityAt(item: TimelineItem, frame: number, hidden = false): number {
  const opacityKeyframes = item.keyframes?.opacity;
  const opacity = opacityKeyframes?.length
    ? sampleKeyframes(opacityKeyframes, frame)
    : item.transform?.opacity ?? 1;
  const visibleOpacity = hidden ? 0 : Math.max(0, Math.min(1, opacity));
  return clipFadeFactor(frame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames) * visibleOpacity;
}

export interface ClipAppearance {
  opacity: number;
  borderRadius: number;
  foregroundStyle: import('react').CSSProperties;
}

/** Per-frame clip appearance (opacity/border/transform/crop/filters) shared by
 *  the clip wrapper and the shared-visual video group. */
export function appearanceAt(item: import('./types').TimelineItem, frame: number, hiddenByCaptions: boolean): ClipAppearance {
  const keyframeValue = (prop: import('./types').KeyframeProp): number | undefined => {
    const values = item.keyframes?.[prop];
    return values?.length ? sampleKeyframes(values, frame) : undefined;
  };
  const transform = item.transform;
  const scale = keyframeValue('scale');
  const scaleX = keyframeValue('scaleX') ?? transform?.scaleX ?? scale ?? transform?.scale ?? 1;
  const scaleY = keyframeValue('scaleY') ?? transform?.scaleY ?? scale ?? transform?.scale ?? 1;
  const hasScale = scale !== undefined || keyframeValue('scaleX') !== undefined || keyframeValue('scaleY') !== undefined
    || transform?.scale !== undefined || transform?.scaleX !== undefined || transform?.scaleY !== undefined;
  const hasTransform = transform || keyframeValue('x') !== undefined || keyframeValue('y') !== undefined
    || keyframeValue('rotation') !== undefined || hasScale;
  const cssTransform = hasTransform
    ? `translate(${keyframeValue('x') ?? transform?.x ?? 0}%, ${keyframeValue('y') ?? transform?.y ?? 0}%) rotate(${keyframeValue('rotation') ?? transform?.rotation ?? 0}deg) scale(${scaleX}, ${scaleY})`
    : undefined;
  const crop = transform?.crop;
  const hasCrop = crop && ((crop.left ?? 0) > 0 || (crop.top ?? 0) > 0 || (crop.right ?? 0) > 0 || (crop.bottom ?? 0) > 0);
  const cropPercent = (value: number | undefined) => `${((value ?? 0) * 100).toFixed(3)}%`;
  const clipPath = hasCrop
    ? `inset(${cropPercent(crop.top)} ${cropPercent(crop.right)} ${cropPercent(crop.bottom)} ${cropPercent(crop.left)})`
    : undefined;
  const opacity = clipOpacityAt(item, frame, hiddenByCaptions);
  const filters = item.filters;
  return {
    opacity,
    borderRadius: Math.max(0, keyframeValue('borderRadius') ?? transform?.borderRadius ?? 0),
    foregroundStyle: {
      transform: cssTransform,
      filter: filters
        ? `brightness(${filters.brightness ?? 1}) contrast(${filters.contrast ?? 1}) saturate(${filters.saturate ?? 1}) blur(${filters.blur ?? 0}px)`
        : undefined,
      clipPath,
    },
  };
}
