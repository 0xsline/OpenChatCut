import type { MediaAsset } from '../editor/types';
import { isMediaImportCancelled } from './mediaImportConflict';

interface MediaImportLifecycle {
  onPlaceholder?: (asset: MediaAsset) => void;
  onAssetUpdated?: (asset: MediaAsset) => void;
  onFailure?: (asset: MediaAsset | null, error: unknown) => void;
}

interface ImportMediaBatchOptions {
  files: readonly File[];
  targetFolderId?: string;
  targetFolderIds?: readonly (string | undefined)[];
  onImport: (
    file: File,
    onProgress?: (ratio: number) => void,
    lifecycle?: MediaImportLifecycle,
  ) => Promise<MediaAsset>;
  onMoveAssets: (ids: string[], folderId?: string) => void;
  onProgress: (ratio: number) => void;
}

/**
 * Starts files sequentially through their first lifecycle event, while allowing
 * already-started files to finish in parallel. Failures never prevent the next
 * file from starting; callers surface the first error after the batch settles.
 */
export async function importMediaBatch({
  files,
  targetFolderId,
  targetFolderIds,
  onImport,
  onMoveAssets,
  onProgress,
}: ImportMediaBatchOptions): Promise<unknown[]> {
  const completions: Promise<void>[] = [];
  const completionErrors: unknown[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    let started = false;
    let failureRecorded = false;
    let resolveStarted!: () => void;
    const firstLifecycleEvent = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const settleStarted = () => {
      if (started) return;
      started = true;
      resolveStarted();
    };
    const placeAsset = (asset: MediaAsset) => {
      const folderId = targetFolderIds?.[index] ?? targetFolderId;
      if (folderId) onMoveAssets([asset.id], folderId);
      settleStarted();
    };
    const recordFailure = (reason: unknown) => {
      if (!failureRecorded && !isMediaImportCancelled(reason)) {
        failureRecorded = true;
        completionErrors.push(reason);
      }
      settleStarted();
    };
    let readyAssetId: string | undefined;

    let completion: Promise<void>;
    try {
      completion = onImport(file, (ratio) => {
        onProgress((index + ratio) / files.length);
      }, {
        onPlaceholder: placeAsset,
        onAssetUpdated: (asset) => {
          readyAssetId = asset.id;
          placeAsset(asset);
        },
        onFailure: (_asset, reason) => recordFailure(reason),
      }).then((asset) => {
        if (readyAssetId !== asset.id) placeAsset(asset);
      }).catch(recordFailure);
    } catch (reason) {
      recordFailure(reason);
      completion = Promise.resolve();
    }

    completions.push(completion);
    await firstLifecycleEvent;
  }

  await Promise.all(completions);
  return completionErrors;
}
