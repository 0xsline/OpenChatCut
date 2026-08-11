import type { Plugin } from 'vite';
import { initializeSqliteProjectStore } from '../storage/sqlite-store.ts';

/**
 * Resolve storage authority before feature plugins restore their persisted
 * state. Migration failure deliberately leaves the legacy backend authoritative
 * and does not prevent the server from starting; the next startup resumes it.
 */
export function storageLifecyclePlugin(): Plugin {
  return {
    name: 'openchatcut-storage-lifecycle',
    async configureServer(server) {
      try {
        const status = await initializeSqliteProjectStore();
        if (status.phase === 'failed') {
          server.config.logger.error(
            `[storage] SQLite migration recovery failed; continuing with legacy storage: ${status.error ?? 'unknown migration error'}`,
          );
        }
      } catch (error) {
        server.config.logger.error(
          `[storage] SQLite migration recovery failed; continuing with legacy storage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
