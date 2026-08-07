import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version.js';
import type { ProjectDoc } from '../../editor/types.js';
import { fitTimelineItems } from '../../editor/clipFit.js';
import { sequenceGraphError } from '../../editor/sequenceGraph.js';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision.js';
import {
  dedupeAssets,
  isDesignStyle,
  isProjectShape,
  isTimelineState,
  normalizeFolders,
  normalizeTimelineTracks,
  timelineToV1,
} from './normalize.js';
import type { ProjectMigrationOptions, ProjectMigrationResult, ProjectMigrationStep } from './types.js';
import { v1ToV2 } from './v1-to-v2.js';
import { v2ToV3 } from './v2-to-v3.js';
import { v3ToV4 } from './v3-to-v4.js';
import { backfillProjectCaptionIdentity } from './captionIdentity.js';

const migrations: readonly ProjectMigrationStep[] = [v1ToV2, v2ToV3, v3ToV4];
const migrationByVersion = new Map(migrations.map((migration) => [migration.fromVersion, migration]));

function startingDocument(value: unknown): { value: unknown; version: number } | null {
  if (isTimelineState(value) && !isProjectShape(value)) return { value: timelineToV1(value), version: 1 };
  if (!isProjectShape(value)) return null;
  if (value.version === undefined) return { value: { ...value, version: 1 }, version: 1 };
  if (typeof value.version !== 'number' || !Number.isInteger(value.version)) return null;
  if (value.version < 1 || value.version > CURRENT_PROJECT_VERSION) return null;
  return { value, version: value.version };
}

function finalize(value: unknown): ProjectDoc | null {
  if (!isProjectShape(value) || value.version !== CURRENT_PROJECT_VERSION) return null;
  const mediaFolders = normalizeFolders(value.mediaFolders);
  const folderIds = new Set(mediaFolders.map((folder) => folder.id));
  const assets = dedupeAssets(Array.isArray(value.assets) ? value.assets : []).map((asset) => (
    asset.folderId && !folderIds.has(asset.folderId) ? { ...asset, folderId: undefined } : asset
  ));
  // Smoothly push back to the legal range: illegal fade/out-of-bounds keyframes can only be repaired here, without waiting for the user to move the clip first.
  const sourceRevisionBySrc = new Map(assets.map((asset) => [asset.src, sourceRevisionOf(asset)]));
  const timelines = value.timelines.map(normalizeTimelineTracks).map(fitTimelineItems).map((timeline) => ({
    ...timeline,
    items: timeline.items.map((item) => (
      item.sourceRevision || !item.src || !sourceRevisionBySrc.has(item.src)
        ? item
        : { ...item, sourceRevision: sourceRevisionBySrc.get(item.src) }
    )),
  }));
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets,
    mediaFolders,
    timelines,
    activeTimelineId: timelines.some((timeline) => timeline.id === value.activeTimelineId)
      ? value.activeTimelineId
      : timelines[0].id,
    ...(isDesignStyle(value.designStyle) ? { designStyle: value.designStyle } : {}),
  };
  const enriched = backfillProjectCaptionIdentity(doc);
  return sequenceGraphError(enriched) ? null : enriched;
}

/** Pure, ordered migration runner. It never mutates or persists the source value. */
export function runProjectMigrations(
  input: unknown,
  options: ProjectMigrationOptions = {},
): ProjectMigrationResult | null {
  const start = startingDocument(input);
  if (!start) return null;
  const sourceVersion = start.version;
  const totalSteps = CURRENT_PROJECT_VERSION - sourceVersion;
  const appliedSteps: string[] = [];
  let value = start.value;
  let version = start.version;

  try {
    while (version < CURRENT_PROJECT_VERSION) {
      const migration = migrationByVersion.get(version);
      if (!migration || migration.toVersion !== version + 1) return null;
      value = migration.migrate(value);
      version = migration.toVersion;
      appliedSteps.push(migration.id);
      try {
        options.onProgress?.({
          fromVersion: migration.fromVersion,
          toVersion: migration.toVersion,
          completedSteps: appliedSteps.length,
          totalSteps,
        });
      } catch {
        // Progress observers must never make a valid document fail migration.
      }
    }
  } catch {
    return null;
  }

  const doc = finalize(value);
  return doc ? { doc, sourceVersion, appliedSteps } : null;
}

export type { ProjectMigrationOptions, ProjectMigrationProgress, ProjectMigrationResult } from './types.js';
