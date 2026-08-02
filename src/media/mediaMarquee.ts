export type MarqueePoint = { x: number; y: number };
export type MarqueeRect = { left: number; top: number; right: number; bottom: number };
export type MarqueeAsset = { id: string; rect: MarqueeRect };

export function marqueeRect(start: MarqueePoint, end: MarqueePoint): MarqueeRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

export function marqueeAssetIds(selection: MarqueeRect, assets: readonly MarqueeAsset[]): string[] {
  return assets
    .filter(({ rect }) => (
      rect.right >= selection.left
      && rect.left <= selection.right
      && rect.bottom >= selection.top
      && rect.top <= selection.bottom
    ))
    .map(({ id }) => id);
}
