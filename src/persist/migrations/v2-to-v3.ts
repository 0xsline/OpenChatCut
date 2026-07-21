import { isProjectShape, normalizeTimelineTracks } from './normalize';
import type { ProjectMigrationStep } from './types';

export const v2ToV3: ProjectMigrationStep = {
  id: 'v2-to-v3',
  fromVersion: 2,
  toVersion: 3,
  migrate(value: unknown): unknown {
    if (!isProjectShape(value)) throw new Error('invalid ProjectDoc V2');
    return {
      ...value,
      version: 3,
      timelines: value.timelines.map(normalizeTimelineTracks),
    };
  },
};

