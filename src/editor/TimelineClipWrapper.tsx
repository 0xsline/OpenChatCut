import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { sampleKeyframes } from './keyframes';
import type { KeyframeProp, TimelineItem } from './types';
import { zoomAt } from './zoom';
import { clipOpacityAt } from './clipFade';

interface ClipAppearance {
  opacity: number;
  borderRadius: number;
  foregroundStyle: CSSProperties;
}

function appearanceAt(item: TimelineItem, frame: number, hiddenByCaptions: boolean): ClipAppearance {
  const keyframeValue = (prop: KeyframeProp): number | undefined => {
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

export function ClipWrapper({ item, frameOffset = 0, hiddenByCaptions = false, children }: {
  item: TimelineItem;
  frameOffset?: number;
  hiddenByCaptions?: boolean;
  children: (borderRadius: number) => ReactNode;
}) {
  const frame = useCurrentFrame() + frameOffset;
  const appearance = appearanceAt(item, frame, hiddenByCaptions);
  let foreground = children(appearance.borderRadius);
  if (item.zoom) {
    const zoom = zoomAt(item.zoom, frame, item.durationInFrames);
    foreground = (
      <AbsoluteFill style={{ transform: `scale(${zoom.magnification})`, transformOrigin: `${zoom.focalX * 100}% ${zoom.focalY * 100}%` }}>
        {foreground}
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ opacity: appearance.opacity, ...appearance.foregroundStyle }}>{foreground}</AbsoluteFill>;
}
