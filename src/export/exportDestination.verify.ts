import assert from 'node:assert/strict';
import {
  chooseExportDestination,
  DEFAULT_EXPORT_DESTINATION,
  ExportDestinationError,
  exportDestinationErrorMessage,
  ensureExportDestinationWritable,
  restoreExportDestination,
  writeBlobToDestination,
  writeUrlToDestination,
  type BrowserExportDirectoryHandle,
  type ExportDestination,
} from './exportDestination';
import { exportDestinationMatchesFilename } from './useExportDestination';

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

function installWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
}

function installIndexedDb(): void {
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = {
        error: null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => ({
          put: () => queueMicrotask(() => transaction.oncomplete?.()),
        }),
      };
      return transaction;
    },
    close: () => undefined,
  };
  const factory = {
    open: () => {
      const request = {
        result: database,
        onsuccess: null as (() => void) | null,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
}

async function verifyBrowserDirectoryWrite(): Promise<void> {
  let permission: 'prompt' | 'granted' = 'prompt';
  let requested = 0;
  let written = '';
  let closed = false;
  const handle: BrowserExportDirectoryHandle = {
    kind: 'directory',
    name: 'Exports',
    queryPermission: async () => permission,
    requestPermission: async () => { requested += 1; permission = 'granted'; return permission; },
    getFileHandle: async (name) => {
      assert.equal(name, 'clip.mp4');
      return { createWritable: async () => ({
        write: async (value) => { written = value instanceof Blob ? await value.text() : String(value); },
        close: async () => { closed = true; },
      }) };
    },
  };
  const destination: ExportDestination = { type: 'browser-directory', label: 'Exports', handle };
  await ensureExportDestinationWritable(destination);
  await writeBlobToDestination(destination, 'clip.mp4', new Blob(['video']));
  assert.equal(requested, 1);
  assert.equal(written, 'video');
  assert.equal(closed, true);
}

async function verifySingleFileUsesSavePicker(): Promise<void> {
  let savePickerCalls = 0;
  let directoryPickerCalls = 0;
  let written = '';
  let suggestedName = '';
  const fileHandle = {
    kind: 'file',
    name: 'clip.mp4',
    queryPermission: async () => 'granted' as const,
    requestPermission: async () => 'granted' as const,
    createWritable: async () => ({
      write: async (value: unknown) => {
        written = value instanceof Blob ? await value.text() : String(value);
      },
      close: async () => undefined,
    }),
  };
  installWindow({
    location: { href: 'http://localhost:5199/' },
    showSaveFilePicker: async (options: { suggestedName: string }) => {
      savePickerCalls += 1;
      suggestedName = options.suggestedName;
      return fileHandle;
    },
    showDirectoryPicker: async () => {
      directoryPickerCalls += 1;
      throw new Error('directory picker invoked for a single-file export');
    },
  });
  const choose = chooseExportDestination as (
    suggestedFilename?: string,
  ) => Promise<ExportDestination | null>;
  const selected = await choose('clip.mp4');
  assert.equal(savePickerCalls, 1);
  assert.equal(directoryPickerCalls, 0);
  assert.equal(selected?.type, 'browser-file');
  assert.equal(suggestedName, 'clip.mp4');
  assert.ok(selected);
  await writeBlobToDestination(selected, 'clip.mp4', new Blob(['video']));
  assert.equal(written, 'video');
}

async function verifyUnsupportedBrowserReportsPickerError(): Promise<void> {
  installWindow({ location: { href: 'http://localhost:5199/' } });
  await assert.rejects(
    () => chooseExportDestination('clip.mp4'),
    (error) => error instanceof ExportDestinationError
      && error.key === '当前浏览器不支持选择导出目录，请使用 Chrome、Edge 或桌面版',
  );
}

async function verifyMultiFileUsesDirectoryPicker(): Promise<void> {
  let savePickerCalls = 0;
  let directoryPickerCalls = 0;
  let pickerMode = '';
  const handle: BrowserExportDirectoryHandle = {
    kind: 'directory',
    name: 'Exports',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async () => ({
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
    }),
  };
  installIndexedDb();
  installWindow({
    location: { href: 'http://localhost:5199/' },
    showSaveFilePicker: async () => {
      savePickerCalls += 1;
      throw new Error('save picker invoked for a multi-file export');
    },
    showDirectoryPicker: async (options: { mode: string }) => {
      directoryPickerCalls += 1;
      pickerMode = options.mode;
      return handle;
    },
  });
  const selected = await chooseExportDestination();
  assert.equal(savePickerCalls, 0);
  assert.equal(directoryPickerCalls, 1);
  assert.equal(pickerMode, 'readwrite');
  assert.equal(selected?.type, 'browser-directory');
}

async function verifyPickerCancellation(): Promise<void> {
  installWindow({
    location: { href: 'http://localhost:5199/' },
    showSaveFilePicker: async () => { throw new DOMException('cancelled', 'AbortError'); },
  });
  assert.equal(await chooseExportDestination('clip.mp4'), null);
  installWindow({
    location: { href: 'http://localhost:5199/' },
    showDirectoryPicker: async () => { throw new DOMException('cancelled', 'AbortError'); },
  });
  assert.equal(await chooseExportDestination(), null);
}

function verifyDestinationCompatibility(): void {
  const fileHandle = {
    kind: 'file' as const,
    name: 'clip.mp4',
    queryPermission: async () => 'granted' as const,
    requestPermission: async () => 'granted' as const,
    createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
  };
  const file: ExportDestination = { type: 'browser-file', label: 'clip.mp4', handle: fileHandle };
  assert.equal(exportDestinationMatchesFilename(file, 'clip.mp4', 'clip.mp4'), true);
  assert.equal(exportDestinationMatchesFilename(file, 'clip.mp4', 'clip.webm'), false);
  assert.equal(exportDestinationMatchesFilename(file, 'clip.mp4', undefined), false);
  const directory: ExportDestination = {
    type: 'browser-directory',
    label: 'Exports',
    handle: {
      kind: 'directory',
      name: 'Exports',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async () => ({ createWritable: fileHandle.createWritable }),
    },
  };
  assert.equal(exportDestinationMatchesFilename(directory, undefined, undefined), true);
  assert.equal(exportDestinationMatchesFilename(directory, undefined, 'clip.mp4'), false);
  assert.equal(exportDestinationMatchesFilename(DEFAULT_EXPORT_DESTINATION, undefined, 'clip.mp4'), true);
}

async function verifyDesktopRestoreAndStreaming(): Promise<void> {
  const grant = { grantId: 'a'.repeat(43), label: 'Exports' };
  installWindow({
    location: { href: 'http://localhost:5199/' },
    openChatCutDesktop: {
      restoreExportDirectory: async () => grant,
      selectExportDirectory: async () => grant,
    },
  });
  assert.deepEqual(await restoreExportDestination(), { type: 'desktop-directory', ...grant });
  assert.deepEqual(await chooseExportDestination(), { type: 'desktop-directory', ...grant });
  const requests: string[] = [];
  let uploaded = '';
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (!init) return new Response('streamed-video');
    uploaded = await new Response(init.body).text();
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const destination: ExportDestination = { type: 'desktop-directory', ...grant };
  await writeUrlToDestination(destination, 'clip.mp4', '/media/uploads/source.mp4');
  assert.deepEqual(requests, [
    'http://localhost:5199/media/uploads/source.mp4',
    `/api/export-destinations/${grant.grantId}/clip.mp4`,
  ]);
  assert.equal(uploaded, 'streamed-video');
  await assert.rejects(() => writeBlobToDestination(destination, '../clip.mp4', new Blob()), /导出文件名无效/);
}

try {
  installWindow({ location: { href: 'http://localhost:5199/' } });
  assert.equal(DEFAULT_EXPORT_DESTINATION.type, 'downloads');
  assert.equal(
    exportDestinationErrorMessage(
      new ExportDestinationError('读取导出文件失败（HTTP {status}）', { status: 404 }),
      (key, params) => key === '读取导出文件失败（HTTP {status}）'
        ? `Reading failed (${params?.status})`
        : key,
    ),
    'Reading failed (404)',
  );
  await verifyBrowserDirectoryWrite();
  await verifySingleFileUsesSavePicker();
  await verifyUnsupportedBrowserReportsPickerError();
  await verifyMultiFileUsesDirectoryPicker();
  await verifyPickerCancellation();
  verifyDestinationCompatibility();
  await verifyDesktopRestoreAndStreaming();
  console.log('export destination verification passed');
} finally {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
  if (indexedDbDescriptor) Object.defineProperty(globalThis, 'indexedDB', indexedDbDescriptor);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
}
