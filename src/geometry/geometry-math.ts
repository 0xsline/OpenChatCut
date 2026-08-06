/**
 * Safe-zone geometry (pure functions, no IO, headless-testable).
 *
<<<<<<< HEAD
 * conventions. Occupancy grid → union over a time range → top-K largest empty
 * rects. All coordinates normalized [0..1], origin top-left.
=======
 * Occupancy grid → union over a time range → top-K largest empty rects. All
 * coordinates normalized [0..1], origin top-left.
>>>>>>> 031e3b0 (fix(geometry): head-zone fallback for undetected faces)
 *
 * Semantics: geometry only (where the person is, where it's empty). Content
 * understanding (what is on screen) stays in the vision/LLM path.
 */

export const GEOM_GRID_W = 18;
export const GEOM_GRID_H = 32; // ~9:16 grid, aspect-agnostic when scaled

/** Normalized rect [0..1], origin top-left. */
export interface GeomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One sampled frame's geometry. */
export interface FrameGeom {
  /** Source-seconds timestamp of the sample. */
  t: number;
  /** Face box in normalized coords, or null when no face detected. */
  face: GeomRect | null;
  /** GRID_W×GRID_H person occupancy (1 = person pixel at that cell). */
  occ: Uint8Array;
}

export interface SafeZone {
  /** Largest placeable empty rects (largest first, normalized). */
  rects: GeomRect[];
  /** Face union over the range (hard exclusion). */
  face: GeomRect | null;
  /** Subject occupancy bbox over the range. */
  subject: GeomRect | null;
  /** Extra hard-exclusion zones (e.g. reserved bottom caption band), for debug overlay. */
  text?: GeomRect[];
}

/** Safe zone for a source time range: union per-frame occupancy in the range
 * (avoid everywhere the subject ever appeared) → largest empty rects in the
 * complement. Frames outside the sampled set fall back to the nearest sample —
 * never a whole-video union (every empty segment would become identical). */
export function safeZoneForRange(
  frames: readonly FrameGeom[],
  start: number,
  end: number,
  blockRects: readonly GeomRect[] = [],
): SafeZone {
  const inRange = frames.filter((f) => f.t >= start - 0.01 && f.t <= end + 0.01);
  let use = inRange;
  if (!use.length && frames.length) {
    const mid = (start + end) / 2;
    use = [frames.reduce((a, b) => (Math.abs(b.t - mid) < Math.abs(a.t - mid) ? b : a))];
  }

  const occ = new Uint8Array(GEOM_GRID_W * GEOM_GRID_H);
  for (const f of use) {
    for (let i = 0; i < occ.length; i++) if (f.occ[i]) occ[i] = 1;
  }

  let face: GeomRect | null = null;
  for (const f of use) {
    if (f.face) face = face ? unionRect(face, f.face) : { ...f.face };
  }

  // Face = hard exclusion (with padding); caption/watermark bands burned into
  // the source are subtracted the same way.
  const blocked = Uint8Array.from(occ);
  if (face) markRect(blocked, padRect(face, 0.04));
  for (const r of blockRects) markRect(blocked, r);

  const subject = occBBox(occ);
  const rects = topKEmptyRects(blocked, 3);
  return { rects, face, subject, ...(blockRects.length ? { text: [...blockRects] } : {}) };
}

function topKEmptyRects(blocked: Uint8Array, k: number): GeomRect[] {
  const work = Uint8Array.from(blocked);
  const rects: GeomRect[] = [];
  for (let i = 0; i < k; i++) {
    const r = largestEmptyRect(work);
    if (!r || r.w * r.h < 8) break; // too small to count (<8 cells)
    rects.push({ x: r.x / GEOM_GRID_W, y: r.y / GEOM_GRID_H, w: r.w / GEOM_GRID_W, h: r.h / GEOM_GRID_H });
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) work[y * GEOM_GRID_W + x] = 1;
    }
  }
  return rects;
}

/** Largest all-empty rect on the grid (histogram method, O(W·H)). */
export function largestEmptyRect(blocked: Uint8Array): { x: number; y: number; w: number; h: number } | null {
  const heights = new Array<number>(GEOM_GRID_W).fill(0);
  let best: { x: number; y: number; w: number; h: number } | null = null;
  let bestArea = 0;
  for (let r = 0; r < GEOM_GRID_H; r++) {
    for (let c = 0; c < GEOM_GRID_W; c++) {
      heights[c] = blocked[r * GEOM_GRID_W + c] ? 0 : heights[c]! + 1;
    }
    const stack: number[] = [];
    for (let c = 0; c <= GEOM_GRID_W; c++) {
      const h = c < GEOM_GRID_W ? heights[c]! : 0;
      while (stack.length && heights[stack[stack.length - 1]!]! >= h) {
        const ph = heights[stack.pop()!]!;
        const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const w = c - left;
        if (ph * w > bestArea) {
          bestArea = ph * w;
          best = { x: left, y: r - ph + 1, w, h: ph };
        }
      }
      stack.push(c);
    }
  }
  return best;
}

export function unionRect(a: GeomRect, b: GeomRect): GeomRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function padRect(r: GeomRect, pad: number): GeomRect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

function markRect(occ: Uint8Array, r: GeomRect): void {
  const x0 = Math.max(0, Math.floor(r.x * GEOM_GRID_W));
  const y0 = Math.max(0, Math.floor(r.y * GEOM_GRID_H));
  const x1 = Math.min(GEOM_GRID_W, Math.ceil((r.x + r.w) * GEOM_GRID_W));
  const y1 = Math.min(GEOM_GRID_H, Math.ceil((r.y + r.h) * GEOM_GRID_H));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) occ[y * GEOM_GRID_W + x] = 1;
  }
}

function occBBox(occ: Uint8Array): GeomRect | null {
  let minx = GEOM_GRID_W;
  let miny = GEOM_GRID_H;
  let maxx = -1;
  let maxy = -1;
  for (let y = 0; y < GEOM_GRID_H; y++) {
    for (let x = 0; x < GEOM_GRID_W; x++) {
      if (occ[y * GEOM_GRID_W + x]) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return null;
  return {
    x: minx / GEOM_GRID_W,
    y: miny / GEOM_GRID_H,
    w: (maxx - minx + 1) / GEOM_GRID_W,
    h: (maxy - miny + 1) / GEOM_GRID_H,
  };
}

/** True when two normalized rects intersect (strictly positive overlap). */
export function intersects(a: GeomRect, b: GeomRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Effective head zone of a segment: the detected face, or — when the face is
 * too small to detect (distant/wide shots) — the top 35% band of the subject
 * bbox as a conservative stand-in. Graphics/captions avoid this zone either
 * way; null only when neither face nor subject exists.
 */
export function headZoneOf(zone: { face: GeomRect | null; subject: GeomRect | null }): GeomRect | null {
  if (zone.face) return zone.face;
  if (!zone.subject || zone.subject.h <= 0) return null;
  return {
    x: zone.subject.x,
    y: zone.subject.y,
    w: zone.subject.w,
    h: Math.max(0.02, zone.subject.h * 0.35),
  };
}
