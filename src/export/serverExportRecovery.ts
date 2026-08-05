import type { TimelineState } from '../editor/types';
import type { ExportDestination } from './exportDestination';

const DATABASE_NAME = 'openchatcut-server-export-recovery';
const STORE_NAME = 'jobs';
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
  const values: unknown[] = hasIndexedDb()
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
  return values
    .filter(validRecord)
    .filter((record) => record.projectId === projectId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

/** Test helper for the Node fallback store. */
export function resetServerExportRecoveryMemory(): void {
  memoryJobs.clear();
}
