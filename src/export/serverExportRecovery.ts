import type { TimelineState } from '../editor/types';
import type { ExportDestination } from './exportDestination';
import {
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
} from '../persist/projectStoreTransport';

const DATABASE_NAME = 'openchatcut-server-export-recovery';
const STORE_NAME = 'jobs';
/** Server-side kv prefix (phase B: recovery state survives cache wipes). */
const REMOTE_PREFIX = 'export-recovery:';
const memoryJobs = new Map<string, PersistedServerExportJob>();

export type ServerExportRecoveryStage = 'polling' | 'target-committed';

export interface PersistedServerExportJob {
  version: 1;
  renderId: string;
  projectId: string;
  label: string;
  targetPath: string | null;
  createdAt: number;
  updatedAt: number;
  format: 'video' | 'audio';
  codec: 'h264' | 'vp8' | 'prores' | 'mp3';
  base: string;
  fps: number;
  state: TimelineState;
  destination: ExportDestination;
  autoQaEnabled: boolean;
  stage: ServerExportRecoveryStage;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'renderId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开导出恢复存储'));
    request.onblocked = () => reject(new Error('导出恢复存储被其他页面占用'));
  });
}

function validRecord(value: unknown): value is PersistedServerExportJob {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PersistedServerExportJob>;
  return record.version === 1
    && typeof record.renderId === 'string' && record.renderId.length > 0
    && typeof record.projectId === 'string' && record.projectId.length > 0
    && typeof record.label === 'string'
    && (record.targetPath === null || typeof record.targetPath === 'string')
    && typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    && typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    && (record.format === 'video' || record.format === 'audio')
    && (record.codec === 'h264' || record.codec === 'vp8' || record.codec === 'prores' || record.codec === 'mp3')
    && typeof record.base === 'string'
    && typeof record.fps === 'number' && record.fps > 0
    && !!record.state && typeof record.state === 'object'
    && !!record.destination && typeof record.destination === 'object'
    && typeof record.autoQaEnabled === 'boolean'
    && (record.stage === 'polling' || record.stage === 'target-committed');
}

export async function persistServerExportJob(record: PersistedServerExportJob): Promise<void> {
  if (projectStoreWriteCredential()) {
    try {
      await requestProjectStore({ operation: 'set', key: `${REMOTE_PREFIX}${record.renderId}`, value: record });
      return; // server is authoritative once reachable
    } catch {
      // fall through to the local store
    }
  }
  if (!hasIndexedDb()) {
    memoryJobs.set(record.renderId, record);
    return;
  }
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('无法保存导出恢复记录'));
      transaction.onabort = () => reject(transaction.error ?? new Error('导出恢复记录写入已取消'));
    });
  } finally {
    database.close();
  }
}

export async function markServerExportTargetCommitted(renderId: string): Promise<void> {
  if (projectStoreWriteCredential()) {
    try {
      const response = await requestProjectStore({ operation: 'entry', key: `${REMOTE_PREFIX}${renderId}` });
      const row = response as { found: boolean; value?: unknown };
      if (row.found && validRecord(row.value)) {
        await requestProjectStore({
          operation: 'set',
          key: `${REMOTE_PREFIX}${renderId}`,
          value: { ...row.value, stage: 'target-committed', updatedAt: Date.now() },
        });
        return;
      }
    } catch {
      // fall through to the local store
    }
  }
  if (!hasIndexedDb()) {
    const current = memoryJobs.get(renderId);
    if (current) memoryJobs.set(renderId, { ...current, stage: 'target-committed', updatedAt: Date.now() });
    return;
  }
  const database = await openDatabase();
  try {
    const current = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(renderId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法读取导出恢复记录'));
    });
    if (!validRecord(current)) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ ...current, stage: 'target-committed', updatedAt: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('无法更新导出恢复记录'));
      transaction.onabort = () => reject(transaction.error ?? new Error('导出恢复记录更新已取消'));
    });
  } finally {
    database.close();
  }
}

export async function deleteServerExportJob(renderId: string): Promise<void> {
  if (projectStoreWriteCredential()) {
    try {
      await requestProjectStore({ operation: 'delete', key: `${REMOTE_PREFIX}${renderId}` });
      return;
    } catch {
      // fall through to the local store
    }
  }
  if (!hasIndexedDb()) {
    memoryJobs.delete(renderId);
    return;
  }
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(renderId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('无法删除导出恢复记录'));
      transaction.onabort = () => reject(transaction.error ?? new Error('导出恢复记录删除已取消'));
    });
  } finally {
    database.close();
  }
}

export async function listServerExportJobs(projectId: string): Promise<PersistedServerExportJob[]> {
  // Phase B: the server snapshot is authoritative; legacy IndexedDB rows are
  // merged in and lazily promoted to the server so old jobs survive wipes.
  const remoteValues: unknown[] = [];
  const remoteRenderIds = new Set<string>();
  let serverReachable = false;
  if (projectStoreRemoteAvailable()) {
    try {
      const snapshotResponse = await requestProjectStore({ operation: 'snapshot' });
      const snapshot = snapshotResponse as { version: 1; entries: Record<string, unknown> };
      for (const [key, value] of Object.entries(snapshot.entries)) {
        if (!key.startsWith(REMOTE_PREFIX)) continue;
        remoteValues.push(value);
        const renderId = key.slice(REMOTE_PREFIX.length);
        if (renderId) remoteRenderIds.add(renderId);
      }
      serverReachable = true;
    } catch {
      // fall through to the local store
    }
  }
  const localValues: unknown[] = hasIndexedDb()
    ? await (async () => {
      const database = await openDatabase();
      try {
        return await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error ?? new Error('无法读取导出恢复记录'));
        });
      } finally {
        database.close();
      }
    })()
    : [...memoryJobs.values()];
  const values = [...remoteValues];
  for (const local of localValues) {
    if (!validRecord(local) || remoteRenderIds.has(local.renderId)) continue;
    values.push(local);
    if (serverReachable && projectStoreWriteCredential()) {
      // Lazy promotion: legacy local rows join the server store once.
      void requestProjectStore({ operation: 'set', key: `${REMOTE_PREFIX}${local.renderId}`, value: local })
        .catch(() => undefined);
    }
  }
  return values
    .filter(validRecord)
    .filter((record) => record.projectId === projectId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

/** Test helper for the Node fallback store. */
export function resetServerExportRecoveryMemory(): void {
  memoryJobs.clear();
}
