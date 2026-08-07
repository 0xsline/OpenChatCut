import { normalizeSha256Hash } from '../../shared/content-hash.js';
import { mapTimelineAssetItems } from './mediaAssetUsage.js';
import { sourceRevisionOf } from './mediaSourceRevision.js';
import { copyTranscriptIdentity } from '../transcript/identity.js';
import type { MediaAsset, ProjectDoc, TimelineItem } from './types.js';

/** Resolve imported master bytes to the first live pool asset with the same valid SHA-256. */
export function findCanonicalMediaAsset(
  assets: readonly MediaAsset[],
  sourceContentHash: unknown,
  excludeAssetId?: string,
): MediaAsset | undefined {
  const canonicalHash = normalizeSha256Hash(sourceContentHash);
  if (!canonicalHash) return undefined;
  return assets.find((asset) => (
    asset.id !== excludeAssetId
    && normalizeSha256Hash(asset.sourceContentHash) === canonicalHash
  ));
}

/** Remove a transient duplicate while atomically retargeting every placement to the pool master. */
export function canonicalizeMediaAsset(
  doc: ProjectDoc,
  duplicateId: string,
  canonicalId: string,
): ProjectDoc {
  const duplicate = doc.assets.find((asset) => asset.id === duplicateId);
  const canonical = doc.assets.find((asset) => asset.id === canonicalId);
  if (!duplicate || !canonical || duplicate.id === canonical.id) return doc;
  const canonicalRevision = sourceRevisionOf(canonical);
  const copiedTranscript = (item: TimelineItem) => copyTranscriptIdentity(
    item.transcript?.length ? item : canonical,
  );
  const useCanonical = (item: TimelineItem): TimelineItem => ({
    ...item,
    ...copiedTranscript(item),
    sourceAssetId: canonical.id,
    src: canonical.src,
    sourceRevision: canonicalRevision,
    sourceContentHash: normalizeSha256Hash(canonical.sourceContentHash),
    sourceFilename: canonical.sourceFilename,
    originalFilePath: canonical.originalFilePath,
  });
  return {
    ...doc,
    assets: doc.assets.filter((asset) => asset.id !== duplicate.id),
    timelines: doc.timelines.map((timeline) => mapTimelineAssetItems(
      timeline,
      duplicate,
      doc.assets,
      useCanonical,
    )),
  };
}
