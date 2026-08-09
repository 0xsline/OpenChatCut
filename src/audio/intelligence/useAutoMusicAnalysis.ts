import { useEffect, useRef } from 'react';
import type { MediaAsset } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { enqueueMusicAnalysis } from './jobs';

function readyRevision(asset: MediaAsset): string | null {
  if (asset.kind !== 'audio' && asset.kind !== 'video') return null;
  if (!asset.src || asset.src.startsWith('blob:') || asset.src.startsWith('data:')) return null;
  return sourceRevisionOf(asset);
}

function revisionMap(assets: readonly MediaAsset[]): Map<string, string> {
  const revisions = new Map<string, string>();
  for (const asset of assets) {
    const revision = readyRevision(asset);
    if (revision) revisions.set(asset.id, revision);
  }
  return revisions;
}
export function changedMusicAnalysisAssets(
  previous: ReadonlyMap<string, string>,
  assets: readonly MediaAsset[],
): { changed: MediaAsset[]; current: Map<string, string> } {
  const current = revisionMap(assets);
  const changed = assets.filter((asset) => {
    const revision = current.get(asset.id);
    return Boolean(revision && previous.get(asset.id) !== revision);
  });
  return { changed, current };
}


/** Observe the canonical asset collection so every import/relink path honors the automatic-analysis opt-in. */
export function useAutoMusicAnalysis(assets: readonly MediaAsset[]): void {
  const previousRef = useRef<Map<string, string>>(revisionMap(assets));
  useEffect(() => {
    const { changed, current } = changedMusicAnalysisAssets(previousRef.current, assets);
    for (const asset of changed) void enqueueMusicAnalysis(asset, { automatic: true });
    previousRef.current = current;
  }, [assets]);
}
