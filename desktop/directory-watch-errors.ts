export type DirectoryWatchOperation = 'start' | 'activate' | 'acknowledge' | 'stop';

const PUBLIC_MESSAGES: Record<DirectoryWatchOperation, string> = {
  start: 'unable to start directory watch',
  activate: 'unable to activate directory watch',
  acknowledge: 'unable to acknowledge directory import',
  stop: 'unable to stop directory watch',
};

function publicStartMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'selected folder was not found';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'selected folder is not readable';
  }
  if (code === 'UNKNOWN' && error instanceof Error && /\bwatch\b/i.test(error.message)) {
    return 'selected folder cannot be watched by the native file watcher';
  }
  if (error instanceof Error) {
    if (error.message === 'the media destination cannot overlap the import directory') {
      return 'selected folder overlaps the media storage directory; choose a separate source folder';
    }
    if (error.name === 'DirectoryScanLimitError') {
      return 'selected folder has too many files or too many nested folders';
    }
  }
  return PUBLIC_MESSAGES.start;
}

function publicMessage(operationName: DirectoryWatchOperation, error: unknown): string {
  return operationName === 'start' ? publicStartMessage(error) : PUBLIC_MESSAGES[operationName];
}

export interface DirectoryWatchWarningEmitter {
  emitWarning(message: string, options: { code: string }): void;
}

export function reportDirectoryWatchError(
  _error: unknown,
  emitter: DirectoryWatchWarningEmitter = process,
): void {
  emitter.emitWarning('directory watch operation failed', {
    code: 'OPENCHATCUT_DIRECTORY_WATCH',
  });
}

export async function invokeDirectoryWatch<T>(
  operationName: DirectoryWatchOperation,
  operation: () => Promise<T>,
  reporter: (error: unknown) => void = reportDirectoryWatchError,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    reporter(error);
    throw new Error(publicMessage(operationName, error));
  }
}
