import { DIRECTORY_PERMISSION, isBrowserDirectoryHandle, safeDirectoryLabel, type BrowserExportDirectoryHandle, type ExportDestination } from './exportDestinationModel';

interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};

const DATABASE_NAME = 'openchatcut-export-destinations';
const STORE_NAME = 'destinations';
const LAST_BROWSER_DIRECTORY_KEY = 'last-browser-directory';
function openDestinationDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = promiseConstructor.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('无法打开导出目录存储'));
  request.onblocked = () => reject(new Error('导出目录存储被其他页面占用'));
  return promise;
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = promiseConstructor.withResolvers<void>();
  transaction.oncomplete = () => resolve(undefined);
  transaction.onerror = () => reject(transaction.error ?? new Error('无法保存导出目录'));
  transaction.onabort = () => reject(transaction.error ?? new Error('导出目录保存已取消'));
  return promise;
}

async function readBrowserDirectory(): Promise<BrowserExportDirectoryHandle | null> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDestinationDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(LAST_BROWSER_DIRECTORY_KEY);
    const { promise, resolve, reject } = promiseConstructor.withResolvers<unknown>();
    request.onsuccess = () => resolve(request.result as unknown);
    request.onerror = () => reject(request.error ?? new Error('无法读取导出目录'));
    const value = await promise;
    return isBrowserDirectoryHandle(value) ? value : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export async function saveBrowserDirectory(handle: BrowserExportDirectoryHandle): Promise<void> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDestinationDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(handle, LAST_BROWSER_DIRECTORY_KEY);
    await transactionComplete(transaction);
  } finally {
    database?.close();
  }
}

async function forgetBrowserDirectory(): Promise<void> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDestinationDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(LAST_BROWSER_DIRECTORY_KEY);
    await transactionComplete(transaction);
  } catch {
    // A denied or invalid handle can safely remain if IndexedDB is unavailable.
  } finally {
    database?.close();
  }
}

export async function restoredBrowserDestination(): Promise<ExportDestination | null> {
  const handle = await readBrowserDirectory();
  if (!handle) return null;
  try {
    const permission = await handle.queryPermission(DIRECTORY_PERMISSION);
    if (permission === 'granted' || permission === 'prompt') {
      return Object.freeze({ type: 'browser-directory', label: safeDirectoryLabel(handle.name), handle });
    }
  } catch {
    // An invalidated structured clone is treated like a denied handle.
  }
  await forgetBrowserDirectory();
  return null;
}
