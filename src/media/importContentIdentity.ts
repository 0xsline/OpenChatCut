import { findCanonicalMediaAsset } from '../editor/mediaContentIdentity.js';
import type { MediaAsset } from '../editor/types.js';
import type { ImportMediaHooks } from './upload.js';

interface ImportContentIdentityOptions {
  getAssets: () => readonly MediaAsset[];
  onCanonical: (canonicalAsset: MediaAsset, duplicateAssetId: string) => void;
}

type ImportContentIdentityHooks = Pick<ImportMediaHooks, 'resolveCanonicalAsset' | 'onCanonical'>;

/** Keep authoritative hash lookup and transient-placeholder cleanup consistent across import entry points. */
export function createImportContentIdentityHooks(
  options: ImportContentIdentityOptions,
): ImportContentIdentityHooks {
  return {
    resolveCanonicalAsset: (sourceContentHash, importingAssetId) => findCanonicalMediaAsset(
      options.getAssets(),
      sourceContentHash,
      importingAssetId,
    ),
    onCanonical: options.onCanonical,
  };
}
