// Shared storage-migration UI helpers (components must stay component-only).
import { fetchWithEditorSession } from '../../persist/projectStoreTransport';

export interface MigrationStatus {
  enabled: boolean;
  receipt: { count: number; importedAt: string } | null;
  jsonKeyCount: number;
  sqliteKeyCount: number;
}

export const STORAGE_BANNER_DISMISS_KEY = 'cc.storageMigrationBannerDismissed';

/** Dispatched after a successful migration so the banner can re-check. */
export const STORAGE_MIGRATED_EVENT = 'cc:storage-migrated';

export async function loadMigrationStatus(): Promise<MigrationStatus> {
  const response = await fetchWithEditorSession('/api/project-store/migrate-status', { method: 'GET' });
  return await response.json() as MigrationStatus;
}
