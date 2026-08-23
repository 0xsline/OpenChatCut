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

export interface MigrateResponse {
  summary?: { imported: number; skipped: number; quarantined: number };
  status?: MigrationStatus;
  error?: string;
}

export const STORAGE_BANNER_DISMISS_KEY = 'cc.storageMigrationBannerDismissed';

/** Dispatched after a successful migration so the banner can re-check. */
export const STORAGE_MIGRATED_EVENT = 'cc:storage-migrated';

async function readStorageMigrationJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!contentType.toLowerCase().includes('json')) {
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (preview.toLowerCase().startsWith('<!doctype') || preview.toLowerCase().startsWith('<html')) {
      throw new Error(`Storage migration endpoint returned HTML instead of JSON (HTTP ${response.status})`);
    }
    throw new Error(`Storage migration endpoint unavailable (HTTP ${response.status})${preview ? `: ${preview}` : ''}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Storage migration endpoint returned invalid JSON (HTTP ${response.status}): ${message}`);
  }
}

/** Delete the migrated legacy JSON files. Requires explicit user consent. */
export async function cleanupLegacyJson(): Promise<{ removed: number; jsonKeyCount: number }> {
  const response = await fetchWithEditorSession('/api/project-store/migrate-cleanup', {
    method: 'POST',
  });
  const body = await readStorageMigrationJson<{ removed?: number; jsonKeyCount?: number; error?: string }>(response);
  if (!response.ok || typeof body.removed !== 'number') {
    throw new Error(body.error ?? 'cleanup failed');
  }
  return { removed: body.removed, jsonKeyCount: body.jsonKeyCount ?? 0 };
}

export async function loadMigrationStatus(): Promise<MigrationStatus> {
  const response = await fetchWithEditorSession('/api/project-store/migrate-status', { method: 'GET' });
  return await readStorageMigrationJson<MigrationStatus>(response);
}

export async function runStorageMigrationRequest(): Promise<MigrateResponse> {
  const response = await fetchWithEditorSession('/api/project-store/migrate', { method: 'POST' });
  const body = await readStorageMigrationJson<MigrateResponse>(response);
  if (!response.ok) {
    throw new Error(body.error ?? 'migration failed');
  }
  return body;
}
