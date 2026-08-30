import { dedupeAssets, isDesignStyle, isProjectShape, normalizeFolders, stripTimelineAssets } from './normalize.js';
import type { ProjectMigrationStep } from './types.js';

export const v1ToV2: ProjectMigrationStep = {
  id: 'v1-to-v2',
  fromVersion: 1,
  toVersion: 2,
  migrate(value: unknown): unknown {
    if (!isProjectShape(value)) throw new Error('invalid ProjectDoc V1');
    const timelineAssets = value.timelines.flatMap((timeline) => timeline.assets ?? []);
    const projectAssets = Array.isArray(value.assets) ? value.assets : [];
    const mediaFolders = normalizeFolders(value.mediaFolders);
    const folderIds = new Set(mediaFolders.map((folder) => folder.id));
    const assets = dedupeAssets([...projectAssets, ...timelineAssets]).map((asset) => (
      asset.folderId && !folderIds.has(asset.folderId) ? { ...asset, folderId: undefined } : asset
    ));
    const timelines = value.timelines.map(stripTimelineAssets);
    return {
      // Unknown V1 top-level fields pass through (v2ToV3 already does this):
      // silently dropping them would violate the migration rule that no field
      // is discarded without an explicit migration step.
      ...value,
      version: 2,
      assets,
      mediaFolders,
      timelines,
      activeTimelineId: timelines.some((timeline) => timeline.id === value.activeTimelineId)
        ? value.activeTimelineId
        : timelines[0].id,
      // Explicit rather than spread-inherited: an invalid designStyle must be
      // dropped here exactly as before, not carried through by `...value`.
      ...(isDesignStyle(value.designStyle) ? { designStyle: value.designStyle } : { designStyle: undefined }),
    };
  },
};
