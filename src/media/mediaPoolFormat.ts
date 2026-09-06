import { ratioLabel, type MediaFolder } from '../editor/types';

export function folderPath(folder: MediaFolder, folders: MediaFolder[]): string {
  const parts = [folder.name];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = folders.find((item) => item.id === parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join('/');
}

export function durationLabel(frames: number, fps: number): string {
  const seconds = Math.max(0, Math.round(frames / fps));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Ratios worth naming on a source file; anything else gets a decimal. */
const NAMED_RATIOS: ReadonlyArray<readonly [number, number]> = [
  [16, 9], [9, 16], [1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [5, 4], [4, 5], [21, 9], [9, 21],
];
/** Encoders round to a codec-friendly size, so a 16:9 source often lands a pixel off. */
const RATIO_TOLERANCE = 0.02;

/**
 * Ratio badge for a source file. Canvas sizes are exact, so ratioLabel's reduced fraction
 * reads well for them; source files are not — a 427×240 trailer is 16:9 to anyone looking
 * at it, and "427:240" (gcd 1) tells the user nothing. Snap to a named ratio when the
 * frame is within tolerance of one, otherwise show the proportion as a decimal.
 */
export function mediaRatioLabel(width?: number, height?: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height || width <= 0 || height <= 0) return null;
  const w = Math.round(width);
  const h = Math.round(height);
  const ratio = w / h;
  const named = NAMED_RATIOS.find(([rw, rh]) => Math.abs(ratio - rw / rh) / (rw / rh) <= RATIO_TOLERANCE);
  if (named) return `${named[0]}:${named[1]}`;
  const exact = ratioLabel(w, h);
  const [a, b] = exact.split(':').map(Number);
  return a <= 32 && b <= 32 ? exact : `${ratio.toFixed(2)}:1`;
}
