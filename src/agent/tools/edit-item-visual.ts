import type { ClipFilters, ClipTransform } from '../../editor/types';
import { CLIP_CROP_EDGES, clipCropAxisSize, clipCropPxToFraction, type ClipCropEdge } from '../../editor/clipCrop';

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export const clampNum = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function parseFiltersArg(raw: unknown): { filters?: ClipFilters; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'filters must be an object {brightness?,contrast?,saturate?,blur?}' };
  }
  const src = raw as Record<string, unknown>;
  const out: ClipFilters = {};
  for (const key of ['brightness', 'contrast', 'saturate', 'blur'] as const) {
    if (src[key] === undefined) continue;
    const n = finiteNum(src[key]);
    if (n === undefined) return { error: `filters.${key} must be a finite number` };
    if (key === 'blur') {
      if (n < 0 || n > 30) return { error: 'filters.blur must be 0..30 (px)' };
      out.blur = Math.round(n * 10) / 10;
    } else {
      if (n < 0 || n > 2) return { error: `filters.${key} must be 0..2 (1 = normal)` };
      out[key] = Math.round(n * 1000) / 1000;
    }
  }
  if (!Object.keys(out).length) return { error: 'filters needs at least one of brightness/contrast/saturate/blur' };
  return { filters: out };
}

const CROP_EDGES = CLIP_CROP_EDGES;

function parseCropArg(
  raw: unknown,
  canvas: { width: number; height: number },
): { crop?: ClipTransform['crop']; clear?: true; error?: string } {
  if (raw === null) return { clear: true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'transform.crop must be null (clear) or {left?,right?,top?,bottom?} in composition pixels' };
  }
  const width = canvas.width;
  const height = canvas.height;
  if (!(width > 0) || !(height > 0)) {
    return { error: 'transform.crop needs a positive canvas size' };
  }
  const src = raw as Record<string, unknown>;
  const unknown = Object.keys(src).filter((key) => !CROP_EDGES.includes(key as ClipCropEdge));
  if (unknown.length) return { error: `transform.crop unknown field: ${unknown.join(', ')}` };
  const crop: NonNullable<ClipTransform['crop']> = {};
  for (const edge of CROP_EDGES) {
    if (src[edge] === undefined) continue;
    const n = finiteNum(src[edge]);
    const axis = clipCropAxisSize(edge, width, height);
    if (n === undefined || n < 0 || n > axis) {
      return { error: `transform.crop.${edge} must be 0..${axis} (composition px)` };
    }
    crop[edge] = clipCropPxToFraction(n, axis);
  }
  if (!Object.keys(crop).length) {
    return { error: 'transform.crop needs at least one of left/right/top/bottom, or null to clear' };
  }
  return { crop };
}

export function parseTransformArg(
  raw: unknown,
  canvas: { width: number; height: number } = { width: 0, height: 0 },
): {
  transform?: ClipTransform;
  cropClear?: boolean;
  error?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'transform must be an object {scale?,scaleX?,scaleY?,x?,y?,rotation?,opacity?,borderRadius?,crop?}' };
  }
  const src = raw as Record<string, unknown>;
  const out: ClipTransform = {};
  let cropClear = false;
  if (src.scale !== undefined) {
    const n = finiteNum(src.scale);
    if (n === undefined || n < 0.05 || n > 16) return { error: 'transform.scale must be 0.05..16 (1 = 100%)' };
    out.scale = Math.round(n * 1000) / 1000;
  }
  for (const key of ['scaleX', 'scaleY'] as const) {
    if (src[key] === undefined) continue;
    const n = finiteNum(src[key]);
    if (n === undefined || n < 0.05 || n > 16) return { error: `transform.${key} must be 0.05..16 (1 = 100%)` };
    out[key] = Math.round(n * 1000) / 1000;
  }
  if (src.x !== undefined) {
    const n = finiteNum(src.x);
    if (n === undefined || n < -400 || n > 400) return { error: 'transform.x must be -400..400 (% of canvas width)' };
    out.x = Math.round(n * 100) / 100;
  }
  if (src.y !== undefined) {
    const n = finiteNum(src.y);
    if (n === undefined || n < -400 || n > 400) return { error: 'transform.y must be -400..400 (% of canvas height)' };
    out.y = Math.round(n * 100) / 100;
  }
  if (src.rotation !== undefined) {
    const n = finiteNum(src.rotation);
    if (n === undefined) return { error: 'transform.rotation must be a finite number (degrees)' };
    out.rotation = Math.round(n * 100) / 100;
  }
  if (src.opacity !== undefined) {
    const n = finiteNum(src.opacity);
    if (n === undefined || n < 0 || n > 1) return { error: 'transform.opacity must be 0..1' };
    out.opacity = Math.round(n * 1000) / 1000;
  }
  if (src.borderRadius !== undefined) {
    const n = finiteNum(src.borderRadius);
    if (n === undefined || n < 0) return { error: 'transform.borderRadius must be ≥ 0 (composition px)' };
    out.borderRadius = Math.round(n * 10) / 10;
  }
  if (src.crop !== undefined) {
    const parsed = parseCropArg(src.crop, canvas);
    if (parsed.error) return { error: parsed.error };
    if (parsed.clear) cropClear = true;
    else out.crop = parsed.crop;
  }
  if (!Object.keys(out).length && !cropClear) {
    return { error: 'transform needs at least one of scale/scaleX/scaleY/x/y/rotation/opacity/borderRadius/crop' };
  }
  return { transform: out, cropClear };
}
