import { kindOfDescriptor } from './mediaProbe';

interface WindowWithDirectoryPicker {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}

export const DIRECTORY_SCAN_MAX_DEPTH = 12;
export const DIRECTORY_SCAN_MAX_FILES = 400;

export interface DirectoryScanResult {
  readonly files: File[];
  readonly folderPaths: readonly (readonly string[])[];
  readonly directories: readonly (readonly string[])[];
  readonly scanned: boolean;
  readonly unsupportedFiles: number;
  readonly limitReached: boolean;
  readonly depthReached: boolean;
}

interface DirectoryScanState {
  files: File[];
  folderPaths: string[][];
  directories: string[][];
  visitedFiles: number;
  unsupportedFiles: number;
  limitReached: boolean;
  depthReached: boolean;
}

function newScanState(): DirectoryScanState {
  return { files: [], folderPaths: [], directories: [], visitedFiles: 0, unsupportedFiles: 0, limitReached: false, depthReached: false };
}

function resultOf(state: DirectoryScanState, scanned: boolean): DirectoryScanResult {
  return {
    files: state.files,
    folderPaths: state.folderPaths,
    directories: state.directories,
    scanned,
    unsupportedFiles: state.unsupportedFiles,
    limitReached: state.limitReached,
    depthReached: state.depthReached,
  };
}

function collectFile(file: File, state: DirectoryScanState, folderPath: readonly string[] = []): void {
  if (state.visitedFiles >= DIRECTORY_SCAN_MAX_FILES) {
    state.limitReached = true;
    return;
  }
  state.visitedFiles += 1;
  if (kindOfDescriptor(file.name, file.type) === null) {
    state.unsupportedFiles += 1;
    return;
  }
  state.files.push(file);
  state.folderPaths.push([...folderPath]);
}

async function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

async function collectEntry(
  entry: FileSystemEntry,
  state: DirectoryScanState,
  depth: number,
  folderPath: readonly string[] = [],
): Promise<void> {
  if (entry.isFile) {
    collectFile(await fileFromEntry(entry as FileSystemFileEntry), state, folderPath);
    return;
  }
  if (!entry.isDirectory) return;
  if (depth >= DIRECTORY_SCAN_MAX_DEPTH) {
    state.depthReached = true;
    return;
  }
  const childFolderPath = [...folderPath, entry.name];
  state.directories.push(childFolderPath);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) return;
    for (const child of entries) {
      if (state.visitedFiles >= DIRECTORY_SCAN_MAX_FILES) {
        state.limitReached = true;
        return;
      }
      await collectEntry(child, state, depth + 1, childFolderPath);
    }
  }
}

export function hasDirectoryEntries(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items ?? [])) {
    try {
      if (item.webkitGetAsEntry?.()?.isDirectory === true) return true;
    } catch {
      // A broken legacy entry adapter must not divert ordinary FileList drops.
    }
  }
  return false;
}

export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DirectoryScanResult> {
  if (!hasDirectoryEntries(dataTransfer)) {
    return {
      files: Array.from(dataTransfer.files ?? []),
      folderPaths: Array.from(dataTransfer.files ?? [], () => []),
      directories: [],
      scanned: false,
      unsupportedFiles: 0,
      limitReached: false,
      depthReached: false,
    };
  }
  const state = newScanState();
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (state.visitedFiles >= DIRECTORY_SCAN_MAX_FILES) {
      state.limitReached = true;
      break;
    }
    const entry = item.webkitGetAsEntry?.();
    if (entry) await collectEntry(entry, state, 0);
    else {
      const file = item.getAsFile();
      if (file) collectFile(file, state);
    }
  }
  return resultOf(state, true);
}

async function collectHandle(
  handle: FileSystemDirectoryHandle,
  state: DirectoryScanState,
  depth: number,
  folderPath: readonly string[],
): Promise<void> {
  if (depth >= DIRECTORY_SCAN_MAX_DEPTH) {
    state.depthReached = true;
    return;
  }
  state.directories.push([...folderPath]);
  for await (const [, child] of handle.entries()) {
    if (state.visitedFiles >= DIRECTORY_SCAN_MAX_FILES) {
      state.limitReached = true;
      return;
    }
    if (child.kind === 'file') collectFile(await child.getFile(), state, folderPath);
    else await collectHandle(child, state, depth + 1, [...folderPath, child.name]);
  }
}

export async function pickMediaFolder(): Promise<DirectoryScanResult> {
  if (typeof window === 'undefined') return resultOf(newScanState(), false);
  const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
  if (typeof picker !== 'function') return resultOf(newScanState(), false);
  const state = newScanState();
  const root = await picker.call(window, { mode: 'read' });
  await collectHandle(root, state, 0, [root.name]);
  return resultOf(state, true);
}

export function canPickMediaFolder(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function';
}
