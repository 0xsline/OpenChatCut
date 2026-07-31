export interface FailedAutosaveRecovery<T> {
  currentUnsaved: T | null;
  failedSnapshot: T;
  failedAttempt: number;
  latestEnqueuedAttempt: number;
}

/**
 * Restore only the latest enqueued snapshot. An older completion must not
 * repopulate the pending slot after a newer snapshot has already been queued.
 */
export function recoverFailedAutosave<T>({
  currentUnsaved,
  failedSnapshot,
  failedAttempt,
  latestEnqueuedAttempt,
}: FailedAutosaveRecovery<T>): T | null {
  if (currentUnsaved !== null || failedAttempt !== latestEnqueuedAttempt) {
    return currentUnsaved;
  }
  return failedSnapshot;
}
