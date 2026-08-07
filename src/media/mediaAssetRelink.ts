import type { MediaAsset, MediaAssetRelinkPatch } from '../editor/types';

export type UploadedMediaRelinkSource = Pick<
  MediaAsset,
  'src' | 'name' | 'kind' | 'sourceRevision' | 'sourceContentHash'
  | 'sourceSize' | 'sourceModifiedAt'
>;

/** Copy every source-bound field when swapping a placeholder or relinking a file. */
export function mediaAssetRelinkPatch(asset: MediaAsset): MediaAssetRelinkPatch {
  return {
    src: asset.src,
    name: asset.name,
    durationInFrames: asset.durationInFrames,
    width: asset.width,
    height: asset.height,
    kind: asset.kind,
    sourceRevision: asset.sourceRevision,
    sourceContentHash: asset.sourceContentHash,
    sourceSize: asset.sourceSize,
    sourceModifiedAt: asset.sourceModifiedAt,
    sourceFilename: asset.sourceFilename,
    originalFilePath: asset.originalFilePath,
  };
}

/** Promote a blob placeholder to the authoritative uploaded master before jobs begin. */
export function uploadedMediaRelinkPatch(
  source: UploadedMediaRelinkSource,
): MediaAssetRelinkPatch {
  return {
    src: source.src,
    name: source.name,
    kind: source.kind,
    sourceRevision: source.sourceRevision,
    sourceContentHash: source.sourceContentHash,
    sourceSize: source.sourceSize,
    sourceModifiedAt: source.sourceModifiedAt,
  };
}
