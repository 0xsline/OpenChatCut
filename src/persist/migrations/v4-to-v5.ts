import { isProjectShape } from './normalize.js';
import type { ProjectMigrationStep } from './types.js';

/**
 * V5 adds the optional per-clip background-fill flag. Existing clips stay off,
 * so the migration only advances the document version without inventing data.
 */
export const v4ToV5: ProjectMigrationStep = {
  id: 'v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrate(value: unknown): unknown {
    if (!isProjectShape(value)) throw new Error('invalid ProjectDoc V4');
    return { ...value, version: 5 };
  },
};
