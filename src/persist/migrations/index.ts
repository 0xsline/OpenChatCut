import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import type { ProjectDoc } from '../../editor/types';
import {
  dedupeAssets,
  isDesignStyle,
  isProjectShape,
  isTimelineState,
  normalizeFolders,
  normalizeTimelineTracks,
  timelineToV1,
} from './normalize';
import type { ProjectMigrationOptions, ProjectMigrationResult, ProjectMigrationStep } from './types';
import { v1ToV2 } from './v1-to-v2';
import { v2ToV3 } from './v2-to-v3';

const migrations: readonly ProjectMigrationStep[] = [v1ToV2, v2ToV3];
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
  const timelines = value.timelines.map(normalizeTimelineTracks);
  return {
    version: CURRENT_PROJECT_VERSION,
    assets,
    mediaFolders,
    timelines,
    activeTimelineId: timelines.some((timeline) => timeline.id === value.activeTimelineId)
      ? value.activeTimelineId
      : timelines[0].id,
    ...(isDesignStyle(value.designStyle) ? { designStyle: value.designStyle } : {}),
  };
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

export type { ProjectMigrationOptions, ProjectMigrationProgress, ProjectMigrationResult } from './types';
