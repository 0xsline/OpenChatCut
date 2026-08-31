export interface PreviewCanvasSize {
  width: number;
  height: number;
}

/**
 * Content box of the preview stage (padding already subtracted).
 * `clientWidth` includes padding, so fitting against it then applying
 * `max-width:100%` shrinks only the row axis and letterboxes the Player on Y.
 */
export function previewStageContentSize(entry: {
  contentBoxSize?: ReadonlyArray<{ inlineSize: number; blockSize: number }> | { inlineSize: number; blockSize: number };
  contentRect: { width: number; height: number };
}): PreviewCanvasSize {
  const box = entry.contentBoxSize;
  const size = Array.isArray(box) ? box[0] : box;
  if (size && Number.isFinite(size.inlineSize) && Number.isFinite(size.blockSize)) {
    return { width: size.inlineSize, height: size.blockSize };
  }
  return { width: entry.contentRect.width, height: entry.contentRect.height };
}

/** Subtract CSS padding from `clientWidth` / `clientHeight` (those include padding). */
export function previewPaddedClientSize(
  client: PreviewCanvasSize,
  padding: { left: number; right: number; top: number; bottom: number },
): PreviewCanvasSize {
  return {
    width: Math.max(0, client.width - padding.left - padding.right),
    height: Math.max(0, client.height - padding.top - padding.bottom),
  };
}

/**
 * Fit the composition into the available preview stage without changing its
 * aspect ratio. The Player scales uniformly inside this rectangle; the orange
 * overlay maps the same box. Rounding width and height independently (or
 * measuring the padded client box) made the wrapper taller than 9:16, so the
 * Player letterboxed on Y. Overlay `inset:0` still covered the wrapper, which
 * kept the drift on screen top/bottom even after the clip rotated, and made
 * the rotation origin orbit.
 */
export function fitPreviewCanvasSize(
  stage: PreviewCanvasSize,
  composition: PreviewCanvasSize,
): PreviewCanvasSize {
  if (
    stage.width <= 0
    || stage.height <= 0
    || composition.width <= 0
    || composition.height <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const widthScale = stage.width / composition.width;
  const heightScale = stage.height / composition.height;
  if (widthScale <= heightScale) {
    return {
      width: stage.width,
      height: stage.width * composition.height / composition.width,
    };
  }
  return {
    width: stage.height * composition.width / composition.height,
    height: stage.height,
  };
}
