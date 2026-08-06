import type { MediaAsset } from '../editor/types';
import { kindOfDescriptor } from './mediaProbe';

/**
 * Folder relink matching: exact filename first (case-insensitive), then
 * extension-insensitive stem matching (e.g. `素材.mp4` matches `素材.mov`).
 * Multiple stem candidates prefer the file whose kind matches the asset.
 */
export function matchRelinkFile(
  asset: Pick<MediaAsset, 'sourceFilename' | 'name' | 'kind'>,
  files: readonly File[],
): File | null {
  const key = (asset.sourceFilename ?? asset.name).toLowerCase();
  if (!key) return null;
  const exact = files.find((file) => file.name.toLowerCase() === key);
  if (exact) return exact;

  const stem = key.replace(/\.[^.]+$/, '');
  if (!stem) return null;
  const candidates = files.filter((file) => {
    const name = file.name.toLowerCase();
    return name !== key && name.replace(/\.[^.]+$/, '') === stem;
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const kindMatch = candidates.find((file) => kindOfDescriptor(file.name, file.type) === asset.kind);
  return kindMatch ?? null;
}
