import { isProjectShape } from './normalize.js';
import type { ProjectMigrationStep } from './types.js';

/**
 * V6 adds an optional background-fill preset. Existing enabled fills keep the
 * medium appearance, represented by an omitted preset for backward safety.
 */
export const v5ToV6: ProjectMigrationStep = {
  id: 'v5-to-v6',
  fromVersion: 5,
  toVersion: 6,
  migrate(value: unknown): unknown {
    if (!isProjectShape(value)) throw new Error('invalid ProjectDoc V5');
    return { ...value, version: 6 };
  },
};
