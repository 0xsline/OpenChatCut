import { useEffect, useRef, useState } from 'react';
import type { ZoomShape } from '../editor/types';
import { shapeCurve } from '../editor/zoom';
import { ensureSampleFrame, getSampleFrame, SAMPLE_H, SAMPLE_W } from '../gl/sampleFrames';

// Photoreal desk sample + exaggerated zoom curve on hover so punch / hold /
// slow-push / instant are easy to tell apart.

const W = SAMPLE_W;
const H = SAMPLE_H;
const DUR_MS = 1400;
const PEAK = 2.15; // stronger than timeline default 1.5 so hover is obvious

interface ZoomThumbProps {
  shape: ZoomShape;
  playing?: boolean;
}

function drawZoom(ctx: CanvasRenderingContext2D, shape: ZoomShape, t: number, sample: HTMLCanvasElement) {
  // t 0..1 cycle
  let env: number;
  if (shape === 'instant') {
    env = t < 0.12 ? 0 : t > 0.88 ? 0 : 1;
  } else if (shape === 'punch' || shape === 'bounce' || shape === 'snap' || shape === 'whip-in') {
    const rise = shape === 'snap' ? 0.18 : shape === 'whip-in' ? 0.28 : 0.35;
    if (t < rise) env = shapeCurve(shape === 'bounce' ? 'bounce' : shape === 'whip-in' ? 'whip-in' : 'punch', t / rise);
    else if (t < 0.7) env = 1;
    else env = 1 - shapeCurve('punch', (t - 0.7) / 0.3);
  } else if (shape === 'pulse') {
    env = shapeCurve('pulse', Math.min(1, t / 0.55));
    if (t > 0.55) env = Math.max(0, 1 - (t - 0.55) / 0.45) * 0.65;
  } else if (shape === 'hold') {
    if (t < 0.35) env = shapeCurve('hold', t / 0.35);
    else if (t < 0.65) env = 1;
    else env = 1 - shapeCurve('hold', (t - 0.65) / 0.35);
  } else if (shape === 'ease-in') {
    env = shapeCurve('ease-in', Math.min(1, t / 0.85));
    if (t > 0.85) env = 1 - (t - 0.85) / 0.15;
  } else if (shape === 'zoom-out') {
    // start zoomed in, pull out
    env = Math.min(1, t / 0.85);
    if (t > 0.85) env = 1;
  } else {
    env = shapeCurve('slow-push', Math.min(1, t / 0.9));
    if (t > 0.9) env = 1 - (t - 0.9) / 0.1;
  }
  const e = Math.max(0, Math.min(1, env));
  const scale = shape === 'zoom-out'
    ? PEAK + (1 - PEAK) * e
    : 1 + (PEAK - 1) * e;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  // slight bias toward face (upper-left of desk shot)
  const fx = W * 0.38;
  const fy = H * 0.42;
  ctx.translate(fx, fy);
  ctx.scale(scale, scale);
  ctx.translate(-fx, -fy);
  ctx.drawImage(sample, 0, 0, W, H);
  ctx.restore();
}

export function ZoomThumb({ shape, playing = false }: ZoomThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [localHover, setLocalHover] = useState(false);
  const [ready, setReady] = useState(false);
  const active = playing || localHover;

  useEffect(() => {
    let cancelled = false;
    ensureSampleFrame('fx').then(() => {
      if (cancelled) return;
      setReady(true);
      const c = canvasRef.current;
      const sample = getSampleFrame('fx');
      if (c && sample) {
        const ctx = c.getContext('2d');
        if (ctx) drawZoom(ctx, shape, 0.4, sample);
      }
    });
    return () => { cancelled = true; };
  }, [shape]);

  useEffect(() => {
    const c = canvasRef.current;
    const sample = getSampleFrame('fx');
    if (!c || !sample) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    if (!active) {
      drawZoom(ctx, shape, 0.4, sample);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = ((now - t0) % DUR_MS) / DUR_MS;
      drawZoom(ctx, shape, t, sample);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, shape, ready]);

  return (
    <div
      className={`cc-live-thumb${active ? ' is-playing' : ''}`}
      onPointerEnter={() => setLocalHover(true)}
      onPointerLeave={() => setLocalHover(false)}
    >
      <canvas
        ref={canvasRef}
        className="cc-live-thumb-canvas always-on"
        width={W}
        height={H}
        aria-hidden
      />
    </div>
  );
}
