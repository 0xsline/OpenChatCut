import type { TimelineState } from '../editor/types';
import type {
  BrowserExportDirectoryHandle,
  BrowserExportFileHandle,
  ExportDestination,
} from './exportDestination';

const DATABASE_NAME = 'openchatcut-server-export-recovery';
const STORE_NAME = 'jobs';
const memoryJobs = new Map<string, PersistedServerExportJob>();

export type ServerExportRecoveryStage =
  | 'polling'
  | 'output-ready'
  | 'delivery-ambiguous'
  | 'target-committed';
export type ServerExportRecoveryDestination =
  | Exclude<ExportDestination, { readonly type: 'browser-directory' | 'browser-file' }>
  | {
    readonly type: 'browser-directory';
    readonly label: string;
    readonly handle: BrowserExportDirectoryHandle | null;
  }
  | {
    readonly type: 'browser-file';
    readonly label: string;
    readonly handle: BrowserExportFileHandle | null;
  };
export interface ServerExportDeliveryClaim {
  ownerInstanceId: string;
  leaseToken: string;
  leaseExpiresAt: number;
}

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
  destination: ServerExportRecoveryDestination;
  autoQaEnabled: boolean;
  stage: ServerExportRecoveryStage;
  remoteAuthorityEstablished?: true;
  deliveryClaim?: ServerExportDeliveryClaim;
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

function isBrowserDirectoryHandle(value: unknown): value is BrowserExportDirectoryHandle {
  if (!value || typeof value !== 'object') return false;
  const handle = value as Partial<BrowserExportDirectoryHandle>;
  return handle.kind === 'directory'
    && typeof handle.name === 'string'
    && typeof handle.getFileHandle === 'function'
    && typeof handle.queryPermission === 'function'
    && typeof handle.requestPermission === 'function';
}

function isBrowserFileHandle(value: unknown): value is BrowserExportFileHandle {
  if (!value || typeof value !== 'object') return false;
  const handle = value as Partial<BrowserExportFileHandle>;
  return handle.kind === 'file'
    && typeof handle.name === 'string'
    && typeof handle.createWritable === 'function'
    && typeof handle.queryPermission === 'function'
    && typeof handle.requestPermission === 'function';
}

function validDestination(value: unknown): value is ServerExportRecoveryDestination {
  if (!value || typeof value !== 'object') return false;
  const destination = value as Partial<ServerExportRecoveryDestination>;
  if (typeof destination.label !== 'string' || !destination.label) return false;
  if (destination.type === 'browser-directory') {
    if (destination.handle === null) return true;
    return typeof destination.handle === 'object'
      && destination.handle.kind === 'directory'
      && typeof destination.handle.name === 'string';
  }
  if (destination.type === 'browser-file') {
    if (destination.handle === null) return true;
    return typeof destination.handle === 'object'
      && destination.handle.kind === 'file'
      && typeof destination.handle.name === 'string';
  }
  if (destination.type === 'downloads') return true;
  if (destination.type === 'desktop-directory') {
    return typeof destination.grantId === 'string';
  }
  return destination.type === 'desktop-file'
    && typeof destination.grantId === 'string'
    && typeof destination.filename === 'string';
}

export function validRecord(value: unknown): value is PersistedServerExportJob {
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
    && validDestination(record.destination)
    && typeof record.autoQaEnabled === 'boolean'
    && (record.stage === 'polling' || record.stage === 'output-ready'
      || record.stage === 'delivery-ambiguous' || record.stage === 'target-committed')
    && (record.deliveryClaim === undefined
      || (typeof record.deliveryClaim === 'object' && record.deliveryClaim !== null
        && typeof record.deliveryClaim.ownerInstanceId === 'string'
        && typeof record.deliveryClaim.leaseToken === 'string'
        && typeof record.deliveryClaim.leaseExpiresAt === 'number'));
}

export function browserDestination(
  destination: ServerExportRecoveryDestination,
): destination is Extract<ServerExportRecoveryDestination, { readonly type: 'browser-directory' | 'browser-file' }> {
  return destination.type === 'browser-directory' || destination.type === 'browser-file';
}

export function hasServerExportDestinationAuthority(
  destination: ServerExportRecoveryDestination,
): destination is ExportDestination {
  if (destination.type === 'browser-directory') return isBrowserDirectoryHandle(destination.handle);
  if (destination.type === 'browser-file') return isBrowserFileHandle(destination.handle);
  return true;
}

export function remoteSafeRecord(record: PersistedServerExportJob): PersistedServerExportJob {
  const {
    remoteAuthorityEstablished: _authority,
    pendingRemoteDelete: _legacyDelete,
    ...activeRecord
  } = record as PersistedServerExportJob & { pendingRemoteDelete?: true };
  if (!browserDestination(activeRecord.destination)) return activeRecord;
  return {
    ...activeRecord,
    destination: { ...activeRecord.destination, handle: null },
  };
}

export async function readLocalRecords(): Promise<PersistedServerExportJob[]> {
  if (!hasIndexedDb()) return [...memoryJobs.values()];
  const database = await openDatabase();
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error('无法读取导出恢复记录'));
    }).then((values) => values.filter(validRecord));
  } finally {
    database.close();
  }
}

export async function readLocalRecord(renderId: string): Promise<PersistedServerExportJob | null> {
  if (!hasIndexedDb()) return memoryJobs.get(renderId) ?? null;
  const database = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(renderId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法读取导出恢复记录'));
    });
    return validRecord(value) ? value : null;
  } finally {
    database.close();
  }
}

export async function writeLocalRecord(record: PersistedServerExportJob): Promise<void> {
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

export async function removeLocalRecord(renderId: string): Promise<void> {
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

/** Test helper for the Node fallback store. */
export function resetServerExportRecoveryMemory(): void {
  memoryJobs.clear();
}
