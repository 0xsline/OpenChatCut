export interface ServerRunLockManager {
  request<T>(
    name: string,
    options: { readonly mode: 'exclusive' },
    callback: () => T | PromiseLike<T>,
  ): Promise<T>;
}

export function serverRunToolLockName(
  projectId: string,
  runId: string,
  toolCallId: string,
): string {
  return JSON.stringify(['openchatcut-server-run-tool', projectId, runId, toolCallId]);
}

export function browserServerRunLockManager(): ServerRunLockManager | null {
  if (typeof navigator === 'undefined' || !navigator.locks) return null;
  return navigator.locks as ServerRunLockManager;
}

export async function withServerRunToolLock<T>(
  lockManager: ServerRunLockManager | null,
  projectId: string,
  runId: string,
  toolCallId: string,
  callback: () => T | PromiseLike<T>,
): Promise<{ readonly acquired: true; readonly value: T } | { readonly acquired: false }> {
  if (!lockManager) return { acquired: false };
  try {
    const value = await lockManager.request(
      serverRunToolLockName(projectId, runId, toolCallId),
      { mode: 'exclusive' },
      callback,
    );
    return { acquired: true, value };
  } catch {
    return { acquired: false };
  }
}
