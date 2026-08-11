// Shared storage-migration UI helpers (components must stay component-only).
import { fetchWithEditorSession } from '../../persist/projectStoreTransport';

export interface MigrationStatus {
  enabled: boolean;
  phase: 'legacy' | 'migrating' | 'complete' | 'failed';
  receipt: { count: number; importedAt: string } | null;
  jsonKeyCount: number;
  sqliteKeyCount: number;
  error?: string;
}

export const STORAGE_BANNER_DISMISS_KEY = 'cc.storageMigrationBannerDismissed';

/** Dispatched after a successful migration so the banner can re-check. */
export const STORAGE_MIGRATED_EVENT = 'cc:storage-migrated';

/** Delete the migrated legacy JSON files. Requires explicit user consent. */
export async function cleanupLegacyJson(): Promise<{ removed: number; jsonKeyCount: number }> {
  const response = await fetchWithEditorSession('/api/project-store/migrate-cleanup', {
    method: 'POST',
  });
  const body = await response.json() as { removed?: number; jsonKeyCount?: number; error?: string };
  if (!response.ok || typeof body.removed !== 'number') {
    throw new Error(body.error ?? 'cleanup failed');
  }
  return { removed: body.removed, jsonKeyCount: body.jsonKeyCount ?? 0 };
}

export async function loadMigrationStatus(): Promise<MigrationStatus> {
  const response = await fetchWithEditorSession('/api/project-store/migrate-status', { method: 'GET' });
  return await response.json() as MigrationStatus;
}
