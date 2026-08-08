import type { TimelineItem } from '../../editor/types.js';
import { isProjectShape } from './normalize.js';
import type { ProjectMigrationStep } from './types.js';

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

/** V7 replaces four stored blur presets with an exact 0..100 percentage. */
export const v6ToV7: ProjectMigrationStep = {
  id: 'v6-to-v7',
  fromVersion: 6,
  toVersion: 7,
  migrate(value: unknown): unknown {
    if (!isProjectShape(value)) throw new Error('invalid ProjectDoc V6');
    return {
      ...value,
      version: 7,
      timelines: value.timelines.map((timeline) => ({
        ...timeline,
        items: timeline.items.map(migrateItem),
      })),
    };
  },
};
