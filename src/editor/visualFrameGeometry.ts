import type { AspectFit } from './types';

export interface VisualFrameSize {
  width: number;
  height: number;
}

export interface VisualFrameRect extends VisualFrameSize {
  x: number;
  y: number;
}

const finitePositive = (value: number, fallback: number): number => (
  Number.isFinite(value) && value > 0 ? value : fallback
);

/** The full source frame after object-fit, including cover overflow. */
export function renderedVisualFrameRect(
  canvas: VisualFrameSize,
  source: VisualFrameSize,
  fit: AspectFit,
): VisualFrameRect {
  const canvasWidth = finitePositive(canvas.width, 0);
  const canvasHeight = finitePositive(canvas.height, 0);
  if (!canvasWidth || !canvasHeight) return { x: 0, y: 0, width: 0, height: 0 };
  const sourceWidth = finitePositive(source.width, canvasWidth);
  const sourceHeight = finitePositive(source.height, canvasHeight);
  const scale = fit === 'cover'
    ? Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
    : Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
}

/**
 * The visible source rectangle inside the composition before clip transforms.
 * `contain` keeps the source aspect; `cover` exposes the canvas-sized crop.
 */
export function visibleVisualFrameRect(
  canvas: VisualFrameSize,
  source: VisualFrameSize,
  fit: AspectFit,
): VisualFrameRect {
  const rendered = renderedVisualFrameRect(canvas, source, fit);
  return fit === 'cover'
    ? { x: 0, y: 0, width: finitePositive(canvas.width, 0), height: finitePositive(canvas.height, 0) }
    : rendered;
}

/** CSS normalizes over-large radii too, but resolving here keeps preview/export geometry explicit. */
export function clampVisualBorderRadius(
  borderRadius: number,
  frame: VisualFrameSize,
): number {
  if (!Number.isFinite(borderRadius) || borderRadius <= 0) return 0;
  return Math.min(borderRadius, Math.max(0, Math.min(frame.width, frame.height) / 2));
}
