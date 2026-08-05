import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import type { CssTransitionType, TransitionDirection } from './types';

interface Entrance {
  opacity: number;
  transform?: string;
  filter?: string;
  clipPath?: string;
  overlay?: { background: string; opacity: number };
}

function smoothstep(x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  return clamped * clamped * (3 - 2 * clamped);
}

function entranceStyle(type: CssTransitionType, p: number, dir: TransitionDirection): Entrance {
  const tri = 1 - Math.abs(2 * p - 1);
  if (type === 'cross-dissolve') return { opacity: smoothstep(p) };
  if (type === 'luma-blend') return { opacity: smoothstep(p), filter: `brightness(${1 + tri * 0.6})` };
  if (type === 'dip-to-black') return { opacity: p >= 0.5 ? 1 : 0, overlay: { background: '#000', opacity: tri } };
  if (type === 'flash') return { opacity: p >= 0.5 ? 1 : 0, overlay: { background: '#fff', opacity: tri * tri } };
  if (type === 'soft-wipe') {
    const hidden = `${Math.max(0, 100 - p * 100).toFixed(2)}%`;
    const clipPath = dir === 'right' ? `inset(0 0 0 ${hidden})`
      : dir === 'up' ? `inset(0 0 ${hidden} 0)`
      : dir === 'down' ? `inset(${hidden} 0 0 0)`
      : `inset(0 ${hidden} 0 0)`;
    return { opacity: 1, clipPath };
  }
  const offset = (1 - p) * 100;
  const sign = dir === 'right' || dir === 'down' ? -1 : 1;
  const axis = dir === 'up' || dir === 'down' ? 'Y' : 'X';
  return { opacity: 1, transform: `translate${axis}(${sign * offset}%)` };
}

function backgroundFor(type: CssTransitionType): string {
  return type === 'flash' ? '#fff' : '#000';
}

interface LayerProps {
  type: CssTransitionType;
  frames: number;
  dir: TransitionDirection;
  line?: boolean;
  children: ReactNode;
}

function StyledLayer({ entrance, children }: { entrance: Entrance; children: ReactNode }) {
  return <AbsoluteFill style={{ opacity: entrance.opacity, transform: entrance.transform, filter: entrance.filter, clipPath: entrance.clipPath }}>{children}</AbsoluteFill>;
}

function WipeLine({ p, dir }: { p: number; dir: TransitionDirection }) {
  if (p <= 0 || p >= 1) return null;
  const vertical = dir === 'left' || dir === 'right';
  const edge = `${(p * 100).toFixed(2)}%`;
  const style: CSSProperties = {
    background: '#fff',
    boxShadow: '0 0 12px rgba(255,255,255,.9)',
    ...(vertical
      ? { top: 0, bottom: 0, width: 4, [dir === 'right' ? 'right' : 'left']: edge }
      : { left: 0, right: 0, height: 4, [dir === 'down' ? 'bottom' : 'top']: edge }),
  };
  return <div style={{ position: 'absolute', transform: 'translate(-2px, -2px)', ...style }} />;
}

function Layer({ style, entrance, line, p, dir, children }: {
  style?: CSSProperties;
  entrance: Entrance;
  line?: boolean;
  p: number;
  dir: TransitionDirection;
  children: ReactNode;
}) {
  return (
    <AbsoluteFill style={style}>
      <StyledLayer entrance={entrance}>{children}</StyledLayer>
      {entrance.overlay && <AbsoluteFill style={{ background: entrance.overlay.background, opacity: entrance.overlay.opacity }} />}
      {line && <WipeLine p={p} dir={dir} />}
    </AbsoluteFill>
  );
}

export function PreviewTransitionIn({ type, frames, dir, line, isolated = false, children }: LayerProps & { isolated?: boolean }) {
  const frame = useCurrentFrame();
  // Keep the wrapper tree stable after completion: remounting BrowserVideo makes
  // Remotion wait for a fresh seek and pauses the shared audio transport.
  const p = Math.max(0, Math.min(1, frame / Math.max(1, frames)));
  const entrance = entranceStyle(type, p, dir);
  return (
    <Layer
      style={isolated ? { background: backgroundFor(type) } : undefined}
      entrance={entrance}
      line={line}
      p={p}
      dir={dir}
    >
      {children}
    </Layer>
  );
}
