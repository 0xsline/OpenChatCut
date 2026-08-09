export type DirectoryWatchOperation = 'start' | 'activate' | 'acknowledge' | 'stop';

const PUBLIC_MESSAGES: Record<DirectoryWatchOperation, string> = {
  start: 'unable to start directory watch',
  activate: 'unable to activate directory watch',
  acknowledge: 'unable to acknowledge directory import',
  stop: 'unable to stop directory watch',
};

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
    throw new Error(PUBLIC_MESSAGES[operationName]);
  }
}
