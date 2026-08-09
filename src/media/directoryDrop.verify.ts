import assert from 'node:assert/strict';
import {
  collectDroppedFiles,
  DIRECTORY_SCAN_MAX_DEPTH,
  DIRECTORY_SCAN_MAX_FILES,
  hasDirectoryEntries,
} from './directoryDrop';

function fileEntry(file: File): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: `/${file.name}`,
    filesystem: {} as FileSystem,
    getParent: () => undefined,
    file: (resolve: (value: File) => void) => resolve(file),
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    filesystem: {} as FileSystem,
    getParent: () => undefined,
    createReader: () => {
      let read = false;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          const entries = read ? [] : children;
          read = true;
          resolve(entries);
        },
      } as FileSystemDirectoryReader;
    },
  } as unknown as FileSystemDirectoryEntry;
}

function item(entry: FileSystemEntry | null, file: File | null = null): DataTransferItem {
  return {
    kind: 'file',
    type: file?.type ?? '',
    getAsFile: () => file,
    getAsString: () => undefined,
    webkitGetAsEntry: () => entry,
  } as unknown as DataTransferItem;
}

function transfer(items: DataTransferItem[], files: File[] = []): DataTransfer {
  return {
    items: items as unknown as DataTransferItemList,
    files: files as unknown as FileList,
  } as DataTransfer;
}

{
  const avi = new File(['avi'], 'camera.avi', { type: 'video/x-msvideo' });
  const mpeg = new File(['mpeg'], 'camera.mpeg', { type: 'video/mpeg' });
  const flat = transfer([item(fileEntry(avi), avi), item(fileEntry(mpeg), mpeg)], [avi, mpeg]);
  assert.equal(hasDirectoryEntries(flat), false);
  const result = await collectDroppedFiles(flat);
  assert.equal(result.scanned, false, 'flat drops must not enter recursive classification');
  assert.deepEqual(result.files, [avi, mpeg], 'flat DataTransfer.files must pass through unchanged');
}

{
  const supported = new File(['video'], 'nested.mp4', { type: 'video/mp4' });
  const unsupported = new File(['text'], 'notes.txt', { type: 'text/plain' });
  const nested = directoryEntry('folder', [fileEntry(supported), fileEntry(unsupported)]);
  const dropped = transfer([item(nested)]);
  assert.equal(hasDirectoryEntries(dropped), true, 'an actual directory entry enables recursion');
  const result = await collectDroppedFiles(dropped);
  assert.equal(result.scanned, true);
  assert.deepEqual(result.files, [supported]);
  assert.equal(result.unsupportedFiles, 1, 'unsupported directory files must be reported explicitly');
}

{
  let entry: FileSystemEntry = fileEntry(new File(['x'], 'deep.mp4', { type: 'video/mp4' }));
  for (let depth = 0; depth <= DIRECTORY_SCAN_MAX_DEPTH; depth += 1) {
    entry = directoryEntry(`level-${depth}`, [entry]);
  }
  const result = await collectDroppedFiles(transfer([item(entry)]));
  assert.equal(result.depthReached, true, 'directory traversal must stop at the depth bound');
}

{
  const files = Array.from({ length: DIRECTORY_SCAN_MAX_FILES + 1 }, (_, index) => (
    fileEntry(new File([String(index)], `clip-${index}.mp4`, { type: 'video/mp4' }))
  ));
  const result = await collectDroppedFiles(transfer([item(directoryEntry('large', files))]));
  assert.equal(result.files.length, DIRECTORY_SCAN_MAX_FILES);
  assert.equal(result.limitReached, true, 'directory traversal must stop after 400 files');
}
