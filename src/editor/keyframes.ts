// Generic transform keyframe engine (PRD §4.5 Generic transform keyframe + pen tool). Pure
// functions only: sampling, boundary-exact split, retime scaling. The split
// contract preserves frame consistency: for every rendered frame,
// pre-split and post-split sampling agree exactly (straddled bezier segments are
// de-Casteljau-subdivided, never approximated).
import type { ItemKeyframes, Keyframe, KeyframeEasing, KeyframeProp } from './types';

/** CSS timing-function control points for the named easings. */
const NAMED_BEZIER: Record<string, readonly [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** boundary validation for LLM/user-supplied easing values. */
export function isValidEasing(e: unknown): e is KeyframeEasing {
  if (e === 'linear' || e === 'easeIn' || e === 'easeOut' || e === 'easeInOut') return true;
  return Array.isArray(e) && e.length === 4 && e.every((n) => typeof n === 'number' && Number.isFinite(n));
}

const bezierOf = (e: KeyframeEasing | undefined): readonly [number, number, number, number] | null => {
  if (!e || e === 'linear') return null;
  if (Array.isArray(e)) return e;
  return NAMED_BEZIER[e] ?? null;
};

// 1D cubic bezier component with endpoints 0/1 and control values c1/c2.
const bez = (c1: number, c2: number, t: number): number => {
  const u = 1 - t;
  return 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t;
};
const bezSlope = (c1: number, c2: number, t: number): number => {
  const u = 1 - t;
  return 3 * u * u * c1 + 6 * u * t * (c2 - c1) + 3 * t * t * (1 - c2);
};

// parameter t where the bezier X component equals x (Newton, bisection fallback).
function solveBezierT(x: number, x1: number, x2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = bez(x1, x2, t) - x;
    if (Math.abs(err) < 1e-9) return t;
    const slope = bezSlope(x1, x2, t);
    if (Math.abs(slope) < 1e-6) break;
    t = Math.min(1, Math.max(0, t - err / slope));
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    t = (lo + hi) / 2;
    if (bez(x1, x2, t) < x) lo = t;
    else hi = t;
  }
  return t;
}

/** eased progress 0..1 for linear progress `p` under a segment easing. */
export function easeProgress(p: number, easing: KeyframeEasing | undefined): number {
  const c = Math.max(0, Math.min(1, p));
  const cp = bezierOf(easing);
  if (!cp) return c;
  return bez(cp[1], cp[3], solveBezierT(c, cp[0], cp[2]));
}

/**
 * Value at an item-local frame. Holds the first/last value outside the keyframe
 * span; interpolates inside by the LEFT keyframe's easing (segment easing).
 * `kfs` must be sorted by frame (reducer invariant); empty list → 0.
 */
export function sampleKeyframes(kfs: readonly Keyframe[], frame: number): number {
  if (!kfs.length) return 0;
  if (frame <= kfs[0].frame) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (frame <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.value;
      return a.value + easeProgress((frame - a.frame) / span, a.easing) * (b.value - a.value);
    }
  }
  return last.value;
}

/** replace-or-insert a keyframe (same frame overwrites); returns a sorted copy. */
export function upsertKeyframe(kfs: readonly Keyframe[] | undefined, frame: number, value: number, easing?: KeyframeEasing): Keyframe[] {
  const rest = (kfs ?? []).filter((k) => k.frame !== frame);
  return [...rest, { frame, value, ...(easing && easing !== 'linear' ? { easing } : {}) }]
    .sort((a, b) => a.frame - b.frame);
}

type Pt = readonly [number, number];
const lerpPt = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Split a segment's easing curve at time fraction p (de Casteljau): returns the
// boundary VALUE fraction `my` plus renormalized left/right control tuples
// (undefined = linear). Exact, so both halves reproduce the original curve.
function subdivideEasing(easing: KeyframeEasing | undefined, p: number): {
  my: number; left?: KeyframeEasing; right?: KeyframeEasing;
} {
  const cp = bezierOf(easing);
  if (!cp) return { my: Math.max(0, Math.min(1, p)) }; // linear halves stay linear
  const t = solveBezierT(p, cp[0], cp[2]);
  const p1: Pt = [cp[0], cp[1]];
  const p2: Pt = [cp[2], cp[3]];
  const q1 = lerpPt([0, 0], p1, t);
  const q2 = lerpPt(p1, p2, t);
  const q3 = lerpPt(p2, [1, 1], t);
  const r1 = lerpPt(q1, q2, t);
  const r2 = lerpPt(q2, q3, t);
  const [mx, my] = lerpPt(r1, r2, t);
  if (mx <= 1e-6 || mx >= 1 - 1e-6) return { my }; // cut at a segment end → nothing to subdivide
  // ponytail: a flat half (my≈0 or ≈1) is value-constant, its curve shape is unobservable → linear
  const left: KeyframeEasing | undefined = my <= 1e-6 ? undefined
    : [q1[0] / mx, q1[1] / my, r1[0] / mx, r1[1] / my];
  const right: KeyframeEasing | undefined = 1 - my <= 1e-6 ? undefined
    : [(r2[0] - mx) / (1 - mx), (r2[1] - my) / (1 - my), (q3[0] - mx) / (1 - mx), (q3[1] - my) / (1 - my)];
  return { my, left, right };
}

/**
 * Split one prop's keyframes at an item-local cut frame into [left, right]
 * (right frames rebased by -cut). Boundary anchors keep sampling identical:
 * for every frame f, sample(orig, f) === (f < cut ? sample(left, f) : sample(right, f - cut)).
 */
export function splitKeyframes(kfs: readonly Keyframe[], cutFrame: number): [Keyframe[], Keyframe[]] {
  if (!kfs.length) return [[], []];
  const left = kfs.filter((k) => k.frame < cutFrame).map((k) => ({ ...k }));
  const right = kfs.filter((k) => k.frame >= cutFrame).map((k) => ({ ...k, frame: k.frame - cutFrame }));
  const a = left[left.length - 1];
  const b = right[0];
  if (a && b) {
    if (b.frame === 0) {
      // a keyframe sits exactly on the cut: it starts the right half; the left
      // half anchors its endpoint value so the a→cut segment keeps its shape.
      left.push({ frame: cutFrame, value: b.value });
    } else {
      const { my, left: le, right: re } = subdivideEasing(a.easing, (cutFrame - a.frame) / (b.frame + cutFrame - a.frame));
      const boundary = a.value + my * (b.value - a.value);
      left[left.length - 1] = { frame: a.frame, value: a.value, ...(le ? { easing: le } : {}) };
      left.push({ frame: cutFrame, value: boundary });
      right.unshift({ frame: 0, value: boundary, ...(re ? { easing: re } : {}) });
    }
  } else if (a && !b) {
    right.push({ frame: 0, value: a.value }); // hold the last value across the right half
  } else if (!a && b) {
    left.push({ frame: 0, value: kfs[0].value }); // hold the first value across the left half
  }
  return [left, right];
}

/** split every keyframed prop at the cut; a side with no keyframes comes back undefined. */
export function splitItemKeyframes(ik: ItemKeyframes, cutFrame: number): [ItemKeyframes | undefined, ItemKeyframes | undefined] {
  const l: ItemKeyframes = {};
  const r: ItemKeyframes = {};
  for (const [prop, kfs] of Object.entries(ik) as [KeyframeProp, Keyframe[]][]) {
    if (!kfs?.length) continue;
    const [lk, rk] = splitKeyframes(kfs, cutFrame);
    if (lk.length) l[prop] = lk;
    if (rk.length) r[prop] = rk;
  }
  return [Object.keys(l).length ? l : undefined, Object.keys(r).length ? r : undefined];
}

/** rescale keyframe frames by `factor` (variable speed): rounds, adjacent collisions collapse (later wins). */
export function scaleKeyframes(kfs: readonly Keyframe[], factor: number): Keyframe[] {
  if (!Number.isFinite(factor) || factor <= 0) return kfs.map((k) => ({ ...k }));
  const out: Keyframe[] = [];
  for (const k of kfs) {
    const frame = Math.round(k.frame * factor);
    if (out.length && out[out.length - 1].frame === frame) out[out.length - 1] = { ...k, frame };
    else out.push({ ...k, frame });
  }
  return out;
}

/** scale every prop's keyframes (undefined-safe; factor 1 returns the input as-is). */
export function scaleItemKeyframes(ik: ItemKeyframes | undefined, factor: number): ItemKeyframes | undefined {
  if (!ik || factor === 1) return ik;
  const out: ItemKeyframes = {};
  for (const [prop, kfs] of Object.entries(ik) as [KeyframeProp, Keyframe[]][]) {
    if (kfs?.length) out[prop] = scaleKeyframes(kfs, factor);
  }
  return Object.keys(out).length ? out : undefined;
}
