import { downloadBlob } from './exportFiles';
import {
  createExportFailure,
  exportFailureFrom,
  ExportFailureError,
  isExportFailure,
} from './exportFailure';

type ExportPermissionState = 'granted' | 'denied' | 'prompt';
type ExportPermissionDescriptor = { mode: 'readwrite' };
interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};

interface BrowserExportWritable {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface BrowserExportDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options: { create: true }): Promise<{
    createWritable(): Promise<BrowserExportWritable>;
  }>;
  queryPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
  requestPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
}

export interface BrowserExportFileHandle {
  readonly kind: 'file';
  readonly name: string;
  createWritable(): Promise<BrowserExportWritable>;
  queryPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
  requestPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
}

export type ExportDestination =
  | { readonly type: 'downloads'; readonly label: string }
  | { readonly type: 'browser-directory'; readonly label: string; readonly handle: BrowserExportDirectoryHandle }
  | { readonly type: 'browser-file'; readonly label: string; readonly handle: BrowserExportFileHandle }
  | { readonly type: 'desktop-directory'; readonly label: string; readonly grantId: string }
  | { readonly type: 'desktop-file'; readonly label: string; readonly grantId: string; readonly filename: string };
export class ExportDestinationError extends Error {
  readonly key: string;
  readonly params?: Record<string, string | number>;

  constructor(key: string, params?: Record<string, string | number>) {
    super(key);
    this.name = 'ExportDestinationError';
    this.key = key;
    this.params = params;
  }
}

export function exportHistoryDestinationId(destination: ExportDestination): string | undefined {
  return destination.type === 'desktop-directory' || destination.type === 'desktop-file'
    ? destination.grantId
    : undefined;
}

export function exportDestinationFilename(destination: ExportDestination, filename: string): string {
  const target = checkedDestination(destination);
  checkedFilename(filename);
  return target.type === 'browser-file'
    ? target.handle.name
    : target.type === 'desktop-file'
      ? target.filename
      : filename;
}

export function exportDestinationErrorMessage(
  error: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (error instanceof ExportDestinationError) return t(error.key, error.params);
  return error instanceof Error ? error.message : t('导出失败');
}

export const DEFAULT_EXPORT_DESTINATION: ExportDestination = Object.freeze({
  type: 'downloads',
  label: '浏览器下载目录',
});

export function exportDestinationTargetPath(destination: ExportDestination, filename: string): string {
  const target = checkedDestination(destination);
  const outputFilename = exportDestinationFilename(target, filename);
  if (target.type === 'browser-file' || target.type === 'desktop-file') return outputFilename;
  return `${target.label.replace(/[\\/]$/, '')}/${outputFilename}`;
}
const DATABASE_NAME = 'openchatcut-export-destinations';
const STORE_NAME = 'destinations';
const LAST_BROWSER_DIRECTORY_KEY = 'last-browser-directory';
const DIRECTORY_PERMISSION: ExportPermissionDescriptor = { mode: 'readwrite' };
const DESKTOP_GRANT_ID = /^[A-Za-z0-9_-]{32,128}$/;
const INVALID_FILENAME = /[/\\:*?"<>|]/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const UNSUPPORTED_BROWSER_PICKER = '当前浏览器不支持选择导出目录，请使用 Chrome、Edge 或桌面版';
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code <= 31 || code === 127 ? '�' : value[index];
  }
  return result;
}

function isBrowserDirectoryHandle(value: unknown): value is BrowserExportDirectoryHandle {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as Partial<BrowserExportDirectoryHandle>;
  return handle.kind === 'directory'
    && typeof handle.name === 'string' && handle.name.length <= 1_000
    && typeof handle.getFileHandle === 'function'
    && typeof handle.queryPermission === 'function'
    && typeof handle.requestPermission === 'function';
}

function isBrowserFileHandle(value: unknown): value is BrowserExportFileHandle {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as Partial<BrowserExportFileHandle>;
  return handle.kind === 'file'
    && typeof handle.name === 'string' && handle.name.length <= 1_000
    && typeof handle.createWritable === 'function'
    && typeof handle.queryPermission === 'function'
    && typeof handle.requestPermission === 'function';
}

function safeDirectoryLabel(name: string): string {
  return replaceControlCharacters(name).slice(0, 500) || 'Selected folder';
}

function validDestinationLabel(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 500
    && !hasControlCharacters(value);
}

function desktopDestination(value: unknown): ExportDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const grantId = 'grantId' in value ? value.grantId : undefined;
  const label = 'label' in value ? value.label : undefined;
  if (typeof grantId !== 'string' || !DESKTOP_GRANT_ID.test(grantId)) return null;
  if (!validDestinationLabel(label)) return null;
  if ('filename' in value) {
    const filename = value.filename;
    if (typeof filename !== 'string' || !validFilename(filename) || label !== filename) return null;
    return Object.freeze({
      type: 'desktop-file',
      grantId,
      label,
      filename,
    });
  }
  return Object.freeze({ type: 'desktop-directory', grantId, label });
}

function checkedDestination(value: unknown): ExportDestination {
  if (typeof value !== 'object' || value === null) throw new ExportDestinationError('导出目录无效');
  const destination = value as Partial<ExportDestination>;
  if (destination.type === 'downloads' && validDestinationLabel(destination.label)) {
    return value as ExportDestination;
  }
  if (destination.type === 'browser-directory' && validDestinationLabel(destination.label)
    && isBrowserDirectoryHandle(destination.handle)) {
    return value as ExportDestination;
  }
  if (destination.type === 'browser-file' && validDestinationLabel(destination.label)
    && isBrowserFileHandle(destination.handle)) {
    return value as ExportDestination;
  }
  if (destination.type === 'desktop-directory' && validDestinationLabel(destination.label)
    && typeof destination.grantId === 'string' && DESKTOP_GRANT_ID.test(destination.grantId)) {
    return value as ExportDestination;
  }
  if (destination.type === 'desktop-file' && validDestinationLabel(destination.label)
    && typeof destination.grantId === 'string' && DESKTOP_GRANT_ID.test(destination.grantId)
    && typeof destination.filename === 'string' && validFilename(destination.filename)
    && destination.label === destination.filename) {
    return value as ExportDestination;
  }
  throw new ExportDestinationError('导出目录授权无效');
}

function validFilename(name: string): boolean {
  if (!name || name !== name.trim() || name === '.' || name === '..') return false;
  if (new TextEncoder().encode(name).byteLength > 240 || INVALID_FILENAME.test(name)
    || hasControlCharacters(name)) return false;
  if (/[. ]$/.test(name) || RESERVED_WINDOWS_NAME.test(name)) return false;
  return true;
}

function checkedFilename(name: unknown): string {
  if (typeof name !== 'string' || !validFilename(name)) throw new ExportDestinationError('导出文件名无效');
  return name;
}

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

async function saveBrowserDirectory(handle: BrowserExportDirectoryHandle): Promise<void> {
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

async function restoredBrowserDestination(): Promise<ExportDestination | null> {
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

async function ensureBrowserWritePermission(
  handle: BrowserExportDirectoryHandle | BrowserExportFileHandle,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const current = await handle.queryPermission(DIRECTORY_PERMISSION);
  signal?.throwIfAborted();
  if (current === 'granted') return;
  if (current === 'prompt') {
    const requested = await handle.requestPermission(DIRECTORY_PERMISSION);
    signal?.throwIfAborted();
    if (requested === 'granted') return;
  }
  throw new ExportDestinationError('没有所选导出目录的写入权限，请重新选择目录');
}

export async function ensureExportDestinationWritable(destination: ExportDestination): Promise<void> {
  const target = checkedDestination(destination);
  if (target.type === 'browser-directory' || target.type === 'browser-file') {
    await ensureBrowserWritePermission(target.handle);
  }
}

function savePickerFunction(): ((
  options: { suggestedName: string },
) => Promise<BrowserExportFileHandle>) | null {
  const picker = (window as Window & {
    showSaveFilePicker?: (
      options: { suggestedName: string },
    ) => Promise<BrowserExportFileHandle>;
  }).showSaveFilePicker;
  return picker ? picker.bind(window) : null;
}

function pickerFunction(): ((options: { mode: 'readwrite' }) => Promise<BrowserExportDirectoryHandle>) | null {
  const picker = (window as Window & {
    showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<BrowserExportDirectoryHandle>;
  }).showDirectoryPicker;
  return picker ? picker.bind(window) : null;
}

export async function restoreExportDestination(): Promise<ExportDestination> {
  const desktop = window.openChatCutDesktop;
  if (desktop) {
    const restored = desktopDestination(await desktop.restoreExportDirectory());
    return restored ?? DEFAULT_EXPORT_DESTINATION;
  }
  return await restoredBrowserDestination() ?? DEFAULT_EXPORT_DESTINATION;
}

export async function chooseExportDestination(
  suggestedFilename?: string,
): Promise<ExportDestination | null> {
  const desktop = window.openChatCutDesktop;
  if (desktop) {
    const selected = suggestedFilename
      ? await desktop.selectExportFile(checkedFilename(suggestedFilename))
      : await desktop.selectExportDirectory();
    return desktopDestination(selected);
  }
  try {
    if (suggestedFilename) {
      const savePicker = savePickerFunction();
      if (!savePicker) throw new ExportDestinationError(UNSUPPORTED_BROWSER_PICKER);
      const handle = await savePicker({ suggestedName: checkedFilename(suggestedFilename) });
      if (!isBrowserFileHandle(handle)) throw new ExportDestinationError('浏览器返回了无效的导出目录');
      return Object.freeze({ type: 'browser-file', label: safeDirectoryLabel(handle.name), handle });
    }
    const directoryPicker = pickerFunction();
    if (!directoryPicker) throw new ExportDestinationError(UNSUPPORTED_BROWSER_PICKER);
    const handle = await directoryPicker({ mode: 'readwrite' });
    if (!isBrowserDirectoryHandle(handle)) throw new ExportDestinationError('浏览器返回了无效的导出目录');
    await saveBrowserDirectory(handle);
    return Object.freeze({ type: 'browser-directory', label: safeDirectoryLabel(handle.name), handle });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

function safeSourceUrl(sourceUrl: unknown): string {
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) throw new ExportDestinationError('导出来源地址无效');
  const parsed = new URL(sourceUrl, window.location.href);
  if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) {
    throw new ExportDestinationError('导出来源地址不受支持');
  }
  return parsed.href;
}

async function browserWritable(
  handle: BrowserExportDirectoryHandle | BrowserExportFileHandle,
  filename: string,
  signal?: AbortSignal,
): Promise<BrowserExportWritable> {
  signal?.throwIfAborted();
  await ensureBrowserWritePermission(handle, signal);
  signal?.throwIfAborted();
  if (handle.kind === 'file') {
    const writable = await handle.createWritable();
    try {
      signal?.throwIfAborted();
      return writable;
    } catch (error) {
      await writable.abort?.(error).catch(() => undefined);
      throw error;
    }
  }
  const file = await handle.getFileHandle(filename, { create: true });
  signal?.throwIfAborted();
  const writable = await file.createWritable();
  try {
    signal?.throwIfAborted();
    return writable;
  } catch (error) {
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  }
}

function desktopWriteError(status: number): ExportDestinationError {
  if (status === 404 || status === 410) {
    return new ExportDestinationError('所选导出目录不可用，请重新选择目录');
  }
  if (status === 400 || status === 401 || status === 403) {
    return new ExportDestinationError('导出目录授权无效');
  }
  if (status === 413) return new ExportDestinationError('导出文件过大，无法写入所选目录');
  return new ExportDestinationError('写入导出目录失败（HTTP {status}）', { status });
}

async function putDesktopBody(
  destination: Extract<ExportDestination, { type: 'desktop-directory' | 'desktop-file' }>,
  filename: string,
  body: Blob | ReadableStream<Uint8Array> | undefined,
  signal?: AbortSignal,
  sourcePath?: string,
): Promise<void> {
  signal?.throwIfAborted();
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'PUT', body, signal,
    ...(sourcePath ? { headers: { 'X-OpenChatCut-Export-Source': sourcePath } } : {}),
  };
  if (body instanceof ReadableStream) init.duplex = 'half';
  const endpoint = `/api/export-destinations/${encodeURIComponent(destination.grantId)}/${encodeURIComponent(filename)}`;
  const response = await fetch(endpoint, init);
  if (response.ok) return;
  signal?.throwIfAborted();
  const payload: unknown = await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (payload && typeof payload === 'object' && 'failure' in payload && isExportFailure(payload.failure)) {
    throw new ExportFailureError(payload.failure);
  }
  await response.body?.cancel().catch(() => undefined);
  signal?.throwIfAborted();
  throw desktopWriteError(response.status);
}

async function writeBrowserBlob(
  handle: BrowserExportDirectoryHandle | BrowserExportFileHandle,
  filename: string,
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const writable = await browserWritable(handle, filename, signal);
  let abortPromise: Promise<void> | null = null;
  const abortWrite = (reason: unknown): Promise<void> => {
    abortPromise ??= writable.abort?.(reason).catch(() => undefined) ?? Promise.resolve();
    return abortPromise;
  };
  const onAbort = () => { void abortWrite(signal?.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    await writable.write(blob);
    signal?.throwIfAborted();
    await writable.close();
  } catch (error) {
    await abortWrite(error);
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function writeBrowserResponse(
  handle: BrowserExportDirectoryHandle | BrowserExportFileHandle,
  filename: string,
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const writable = await browserWritable(handle, filename, signal);
  const reader = response.body?.getReader();
  let bytesWritten = 0;
  let abortPromise: Promise<void> | null = null;
  const abortWrite = (reason: unknown): Promise<void> => {
    abortPromise ??= Promise.all([
      reader?.cancel(reason).catch(() => undefined),
      writable.abort?.(reason).catch(() => undefined),
    ]).then(() => undefined);
    return abortPromise;
  };
  const onAbort = () => { void abortWrite(signal?.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    if (reader) {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        signal?.throwIfAborted();
        if (chunk.done) break;
        bytesWritten += chunk.value.byteLength;
        await writable.write(chunk.value);
        signal?.throwIfAborted();
      }
    }
    signal?.throwIfAborted();
    if (bytesWritten === 0) throw new ExportDestinationError('导出文件为空');
    await writable.close();
  } catch (error) {
    await abortWrite(error);
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader?.releaseLock();
  }
}

function destinationWriteFailure(error: unknown, targetPath: string): ExportFailureError {
  const existing = exportFailureFrom(error);
  if (existing) return new ExportFailureError(existing);
  const empty = error instanceof ExportDestinationError && error.key === '导出文件为空';
  return new ExportFailureError(createExportFailure({
    stage: 'destination',
    code: empty ? 'export_output_empty' : 'export_destination_write_failed',
    retryable: true,
    targetPath,
    message: error instanceof Error ? error.message : String(error),
  }));
}

export async function writeBlobToDestination(
  destination: ExportDestination,
  filename: string,
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const target = checkedDestination(destination);
  const safeName = checkedFilename(filename);
  const outputFilename = exportDestinationFilename(target, safeName);
  const targetPath = exportDestinationTargetPath(target, outputFilename);
  try {
    signal?.throwIfAborted();
    if (!(blob instanceof Blob)) throw new ExportDestinationError('导出文件内容无效');
    if (blob.size === 0) throw new ExportDestinationError('导出文件为空');
    if (target.type === 'downloads') {
      signal?.throwIfAborted();
      downloadBlob(blob, outputFilename);
      return;
    }
    if (target.type === 'browser-directory' || target.type === 'browser-file') {
      await writeBrowserBlob(target.handle, outputFilename, blob, signal);
      return;
    }
    await putDesktopBody(target, outputFilename, blob, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw destinationWriteFailure(error, targetPath);
  }
}

export async function writeUrlToDestination(
  destination: ExportDestination,
  filename: string,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const target = checkedDestination(destination);
  const safeName = checkedFilename(filename);
  const outputFilename = exportDestinationFilename(target, safeName);
  const targetPath = exportDestinationTargetPath(target, outputFilename);
  let safeSource: string;
  try {
    safeSource = safeSourceUrl(sourceUrl);
  } catch (error) {
    throw destinationWriteFailure(error, targetPath);
  }
  const localSource = new URL(safeSource);
  if ((target.type === 'desktop-directory' || target.type === 'desktop-file')
    && localSource.origin === new URL(window.location.href).origin
    && localSource.pathname.startsWith('/media/uploads/')) {
    try {
      await putDesktopBody(target, outputFilename, undefined, signal, localSource.pathname);
      return;
    } catch (error) {
      signal?.throwIfAborted();
      throw destinationWriteFailure(error, targetPath);
    }
  }
  let response: Response;
  try {
    signal?.throwIfAborted();
    response = await fetch(safeSource, signal ? { signal } : undefined);
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    throw destinationWriteFailure(error, targetPath);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    throw new ExportFailureError(createExportFailure({
      stage: 'destination',
      code: 'export_source_read_failed',
      retryable: response.status >= 500,
      targetPath,
      message: `读取导出文件失败（HTTP ${response.status}）`,
    }));
  }
  try {
    signal?.throwIfAborted();
    if (target.type === 'browser-directory' || target.type === 'browser-file') {
      await writeBrowserResponse(target.handle, outputFilename, response, signal);
      return;
    }
    if (target.type === 'desktop-directory' || target.type === 'desktop-file') {
      await putDesktopBody(target, outputFilename, response.body ?? new Blob(), signal);
      return;
    }
    const blob = await response.blob();
    signal?.throwIfAborted();
    if (blob.size === 0) throw new ExportDestinationError('导出文件为空');
    downloadBlob(blob, outputFilename);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    throw destinationWriteFailure(error, targetPath);
  }
}
