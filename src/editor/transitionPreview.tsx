import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CSS_TRANSITION_TYPES } from './types';
import type { AspectFit, CssTransitionType, TimelineItem, TransitionDirection, TransitionItem } from './types';

const PREVIEW_APPROXIMATION: Partial<Record<TransitionItem['type'], CssTransitionType>> = {
  'clean-line-wipe': 'soft-wipe',
  'page-curl': 'soft-wipe',
  'impact-shake': 'whip-pan',
  'rack-focus': 'luma-blend',
  'organic-dissolve': 'luma-blend',
  'anticipation-zoom': 'luma-blend',
  'radial-blur': 'luma-blend',
  'glitch-cut': 'flash',
  'dip-to-color': 'dip-to-black',
};

export function previewTransitionType(type: TransitionItem['type']): CssTransitionType {
  if (CSS_TRANSITION_TYPES.has(type)) return type as CssTransitionType;
  return PREVIEW_APPROXIMATION[type] ?? 'cross-dissolve';
}

export function previewTransitionParts(durationInFrames: number) {
  const duration = Math.max(1, Math.round(durationInFrames));
  const outFrames = Math.floor(duration / 2);
  return { outFrames, inFrames: duration - outFrames };
}

export function transitionStillSrc(item: TimelineItem, sourceFrame: number, fps: number): string | undefined {
  if (!item.src) return undefined;
  if (item.kind === 'image' || item.kind === 'gif' || item.kind === 'svg') return item.src;
  if (item.kind !== 'video' || !item.src.startsWith('/media/uploads/')) return undefined;
  const params = new URLSearchParams({
    src: item.src.split('#')[0],
    time: (Math.max(0, sourceFrame) / Math.max(1, fps)).toFixed(3),
  });
  return `/api/media-frame?${params}`;
}

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
  frozenSrc?: string;
  preloadSrc?: string;
  fit?: AspectFit;
  children: ReactNode;
}

function StyledLayer({ entrance, children }: { entrance: Entrance; children: ReactNode }) {
  return <AbsoluteFill style={{ opacity: entrance.opacity, transform: entrance.transform, filter: entrance.filter, clipPath: entrance.clipPath }}>{children}</AbsoluteFill>;
}

function FrozenFrame({ src, fit = 'contain' }: { src: string; fit?: AspectFit }) {
  return <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
    <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: fit === 'cover' ? 'cover' : 'contain' }} />
  </AbsoluteFill>;
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

function Layer({ style, entrance, children }: { style?: CSSProperties; entrance: Entrance; children: ReactNode }) {
  return (
    <AbsoluteFill style={style}>
      <StyledLayer entrance={entrance}>{children}</StyledLayer>
      {entrance.overlay && <AbsoluteFill style={{ background: entrance.overlay.background, opacity: entrance.overlay.opacity }} />}
    </AbsoluteFill>
  );
}

export function PreviewTransitionIn({ type, frames, dir, line, frozenSrc, fit, isolated = false, children }: LayerProps & { isolated?: boolean }) {
  const frame = useCurrentFrame();
  if (frame >= frames) return <AbsoluteFill>{children}</AbsoluteFill>;
  const p = frozenSrc ? 0.5 + 0.5 * frame / Math.max(1, frames - 1) : frame / Math.max(1, frames);
  const entrance = entranceStyle(type, Math.max(0, p), dir);
  if (frozenSrc) return (
    <AbsoluteFill>
      <FrozenFrame src={frozenSrc} fit={fit} />
      <StyledLayer entrance={entrance}>{children}</StyledLayer>
      {entrance.overlay && <AbsoluteFill style={{ background: entrance.overlay.background, opacity: entrance.overlay.opacity }} />}
      {line && <WipeLine p={p} dir={dir} />}
    </AbsoluteFill>
  );
  return <Layer style={isolated ? { background: backgroundFor(type) } : undefined}
    entrance={entrance}>{children}</Layer>;
}

export function PreviewTransitionOut({ type, frames, dir, line, duration, frozenSrc, preloadSrc, fit, children }: LayerProps & { duration: number }) {
  const frame = useCurrentFrame();
  const local = frame - (duration - frames);
  if (local < 0) return (
    <AbsoluteFill>
      {children}
      <AbsoluteFill style={{ opacity: 0, pointerEvents: 'none' }}>
        {frozenSrc && <FrozenFrame src={frozenSrc} fit={fit} />}
        {preloadSrc && <FrozenFrame src={preloadSrc} fit={fit} />}
      </AbsoluteFill>
    </AbsoluteFill>
  );
  const p = 0.5 * local / Math.max(1, frames - 1);
  if (frozenSrc) {
    const entrance = entranceStyle(type, Math.max(0, p), dir);
    return (
      <AbsoluteFill>
        {children}
        <StyledLayer entrance={entrance}><FrozenFrame src={frozenSrc} fit={fit} /></StyledLayer>
        {entrance.overlay && <AbsoluteFill style={{ background: entrance.overlay.background, opacity: entrance.overlay.opacity }} />}
        {line && <WipeLine p={p} dir={dir} />}
      </AbsoluteFill>
    );
  }
  return <Layer style={{ background: backgroundFor(type) }}
    entrance={entranceStyle(type, Math.max(0, 1 - p * 2), dir)}>{children}</Layer>;
}
