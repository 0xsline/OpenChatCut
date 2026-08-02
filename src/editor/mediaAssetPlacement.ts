export interface PlaceableMediaAsset {
  id: string;
  durationInFrames: number;
}

interface MediaAssetPlacementOptions<TAsset extends PlaceableMediaAsset> {
  assetIds: readonly string[];
  assets: readonly TAsset[];
  startFrame: number;
  add: (asset: TAsset, startFrame: number) => string;
  select: (itemIds: string[]) => void;
}

/** Place every selected pool asset contiguously and preserve their common selection. */
export function placeMediaAssets<TAsset extends PlaceableMediaAsset>({
  assetIds,
  assets,
  startFrame,
  add,
  select,
}: MediaAssetPlacementOptions<TAsset>): boolean {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const selectedAssets = assetIds
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is TAsset => !!asset);
  if (!selectedAssets.length) return false;

  let nextStartFrame = Math.max(0, Math.round(startFrame));
  const itemIds = selectedAssets.map((asset) => {
    const itemId = add(asset, nextStartFrame);
    nextStartFrame += Math.max(1, asset.durationInFrames);
    return itemId;
  });
  select(itemIds);
  return true;
}
