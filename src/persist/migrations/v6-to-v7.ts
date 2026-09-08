import type { TimelineItem } from '../../editor/types.js';
import { isProjectShape, type LooseProjectShape } from './normalize.js';

const LEGACY_STRENGTH = {
  soft: 25,
  medium: 50,
  strong: 75,
  maximum: 100,
} as const;

type LegacyPreset = keyof typeof LEGACY_STRENGTH;

function isLegacyPreset(value: unknown): value is LegacyPreset {
  return typeof value === 'string' && Object.hasOwn(LEGACY_STRENGTH, value);
}

function migrateItem(item: TimelineItem): TimelineItem {
  if (!('backgroundFillPreset' in item)) return item;
  const { backgroundFillPreset, ...rest } = item;
  if (item.backgroundFill !== true || !isLegacyPreset(backgroundFillPreset)) return rest;
  const strength = LEGACY_STRENGTH[backgroundFillPreset];
  return strength === 50 ? rest : { ...rest, backgroundFillStrength: strength };
}

/**
 * V4-V7 were development-only project versions that never shipped. They collapse
 * straight back to CURRENT_PROJECT_VERSION in collapseDevelopmentVersion rather than
 * stepping through an ordered migration, so this module exports the field normalizer
 * only — there is deliberately no v6ToV7 ProjectMigrationStep. Adding one would be
 * dead code: the runner's migrationByVersion map is built from released steps alone.
 *
 * Remove unreleased preset fields while preserving every other project field.
 */
export function normalizeDevelopmentBackgroundFillPresets(value: unknown): LooseProjectShape {
  if (!isProjectShape(value)) throw new Error('invalid development ProjectDoc');
  return {
    ...value,
    timelines: value.timelines.map((timeline) => ({
      ...timeline,
      items: timeline.items.map(migrateItem),
    })),
  };
}
