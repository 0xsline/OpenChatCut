import { watch as watchFileSystem, type FSWatcher } from 'node:fs';

const POLLING_INTERVAL_MS = 2000;
type NativeWatchFactory = (
  path: string,
  options: { recursive: true },
  listener: () => void,
) => FSWatcher;

export interface DirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DirectoryWatchHandle {
  close(): void;
  on?(eventName: 'error', listener: (error: unknown) => void): DirectoryWatchHandle;
  poll?(): void;
}

export class DirectoryScanLimitError extends Error {
  readonly kind: 'files' | 'depth';
  readonly limit: number;

  constructor(kind: 'files' | 'depth', limit: number) {
    super(`directory scan exceeded the ${kind} limit (${limit})`);
    this.name = 'DirectoryScanLimitError';
    this.kind = kind;
    this.limit = limit;
  }
}

export function createDirectoryWatchHandle(
  path: string,
  listener: () => void,
  watch: NativeWatchFactory = watchFileSystem as NativeWatchFactory,
  pollingIntervalMs = POLLING_INTERVAL_MS,
): DirectoryWatchHandle {
  let native: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let polling = false;
  const closeNative = (): void => {
    try { native?.close(); } finally { native = null; }
  };
  const schedule = (): void => {
    if (closed || !polling || timer) return;
    timer = setTimeout(() => {
      timer = null;
      listener();
    }, pollingIntervalMs);
    timer.unref?.();
  };
  try {
    native = watch(path, { recursive: true }, listener);
    native.on('error', () => {
      closeNative();
      polling = true;
      schedule();
    });
  } catch {
    polling = true;
  }
  return {
    close: () => {
      closed = true;
      closeNative();
      if (timer) clearTimeout(timer);
      timer = null;
    },
    poll: schedule,
  };
}
