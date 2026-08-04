export interface PreviewCanvasSize {
  width: number;
  height: number;
}

/**
 * Fit the composition into the available preview stage without changing its
 * aspect ratio. The Player and every interactive overlay share this rectangle.
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
  const compositionAspect = composition.width / composition.height;
  if (stage.width / stage.height <= compositionAspect) {
    return {
      width: stage.width,
      height: stage.width / compositionAspect,
    };
  }
  return {
    width: stage.height * compositionAspect,
    height: stage.height,
  };
}
