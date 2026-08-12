import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import type { TimelineItem } from './types';
import { zoomAt } from './zoom';
import { appearanceAt } from './clipFade';

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
