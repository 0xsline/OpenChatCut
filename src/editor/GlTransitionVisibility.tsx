import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { isGlBaseHidden, type GlVisibilityWindow } from './glTransitionVisibilityState';

export function GlTransitionVisibility({
  itemId,
  sequenceFrom,
  windows,
  readyWindows,
  children,
}: {
  itemId: string;
  sequenceFrom: number;
  windows: readonly GlVisibilityWindow[];
  readyWindows: ReadonlySet<string>;
  children: ReactNode;
}) {
  const hidden = isGlBaseHidden(itemId, useCurrentFrame() + sequenceFrom, windows, readyWindows);
  return <AbsoluteFill style={hidden ? { visibility: 'hidden' } : undefined}>{children}</AbsoluteFill>;
}
