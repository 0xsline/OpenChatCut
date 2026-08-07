import { isProjectShape } from './normalize.js';
import type { ProjectMigrationStep } from './types.js';

/**
 * V4 adds optional content-addressed media identity and stable caption-word
 * references. Existing documents need no synthetic values: hashes require the
 * source bytes, while stable refs are attached on the next caption edit.
 */
export const v3ToV4: ProjectMigrationStep = {
  id: 'v3-to-v4',
  fromVersion: 3,
  toVersion: 4,
  migrate(value: unknown): unknown {
    if (!isProjectShape(value)) throw new Error('invalid ProjectDoc V3');
    return { ...value, version: 4 };
  },
};
