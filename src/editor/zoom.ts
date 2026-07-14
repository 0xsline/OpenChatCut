// builtin:zoom evaluation — faithful to ChatCut's parametric zoom (entry.js
// A2/lPe/uPe curves) plus the ReframeCurveV1 sparse-keyframe override.
import type { ZoomEffect, ZoomShape } from './types';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// source shape curves (entry.js A2): punch = cubic ease-out, hold = cubic
// ease-in-out, slow-push / instant = linear. Extended: zoom-out / ease-in / bounce.
export function shapeCurve(shape: ZoomShape, t: number): number {
  const c = clamp01(t);
  if (shape === 'punch') return 1 - Math.pow(1 - c, 3);
  if (shape === 'hold') return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
  if (shape === 'ease-in') return c * c * c;
  if (shape === 'bounce') {
    // overshoot then settle near 1
    const s = 1.70158 * 1.2;
    const x = c - 1;
    return 1 + x * x * ((s + 1) * x + s);
  }
  // slow-push / instant / zoom-out use linear envelope; zoom-out inverts in zoomAt
  return c;
}

// source default ease frames per shape (entry.js uPe/dPe), overridable by the effect.
export function easeFrames(z: ZoomEffect, dur: number): { easeIn: number; easeOut: number } {
  const shape = z.shape ?? 'hold';
  let easeIn: number;
  let easeOut: number;
  switch (shape) {
    case 'instant': easeIn = 0; easeOut = 0; break;
    case 'slow-push': easeIn = dur; easeOut = 0; break;
    case 'punch': easeIn = Math.round(dur * 0.2) || 8; easeOut = 0; break;
    case 'zoom-out': easeIn = Math.round(dur * 0.35) || 10; easeOut = 0; break;
    case 'ease-in': easeIn = Math.round(dur * 0.55) || 12; easeOut = 0; break;
    case 'bounce': easeIn = Math.round(dur * 0.4) || 12; easeOut = Math.round(dur * 0.15) || 4; break;
    default: easeIn = 8; easeOut = 8; // hold
  }
  if (z.easeInFrames !== undefined) easeIn = z.easeInFrames;
  if (z.easeOutFrames !== undefined) easeOut = z.easeOutFrames;
  return { easeIn: Math.max(0, Math.min(dur, easeIn)), easeOut: Math.max(0, Math.min(dur, easeOut)) };
}

export interface ZoomState {
  magnification: number;
  focalX: number;
  focalY: number;
}

// linear interpolation across sparse reframe keyframes (ReframeCurveV1 carries no
// per-keyframe easing → implicit linear, per the source model).
function reframeAt(curve: NonNullable<ZoomEffect['reframeCurve']>, f: number): ZoomState | null {
  const ks = curve.keyframes;
  if (!ks.length) return null;
  if (f <= ks[0].frame) return { magnification: ks[0].magnification, focalX: ks[0].focalPointX, focalY: ks[0].focalPointY };
  const last = ks[ks.length - 1];
  if (f >= last.frame) return { magnification: last.magnification, focalX: last.focalPointX, focalY: last.focalPointY };
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (f >= a.frame && f <= b.frame) {
      const t = b.frame === a.frame ? 0 : (f - a.frame) / (b.frame - a.frame);
      return {
        magnification: a.magnification + (b.magnification - a.magnification) * t,
        focalX: a.focalPointX + (b.focalPointX - a.focalPointX) * t,
        focalY: a.focalPointY + (b.focalPointY - a.focalPointY) * t,
      };
    }
  }
  return null;
}

// zoom state (magnification + focal point) at effect-local frame f over a clip of
// `dur` frames. Reframe keyframes win when present, else the parametric envelope.
export function zoomAt(z: ZoomEffect, f: number, dur: number): ZoomState {
  const focalX = z.focalPointX ?? 0.5;
  const focalY = z.focalPointY ?? 0.5;
  if (z.reframeCurve && z.reframeCurve.keyframes.length) {
    const r = reframeAt(z.reframeCurve, f);
    if (r) return r;
  }
  const mag = z.magnification ?? 1.5;
  const shape = z.shape ?? 'hold';
  const { easeIn, easeOut } = easeFrames(z, dur);
  let env: number;
  if (easeIn > 0 && f < easeIn) env = shapeCurve(shape, f / easeIn);
  else if (easeOut > 0 && f > dur - easeOut) env = shapeCurve(shape, (dur - f) / easeOut);
  else env = 1;
  env = clamp01(env);
  // zoom-out: start tight, pull back to 1×
  if (shape === 'zoom-out') {
    return { magnification: mag + (1 - mag) * env, focalX, focalY };
  }
  return { magnification: 1 + (mag - 1) * env, focalX, focalY };
}
