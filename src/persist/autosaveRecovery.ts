export interface AutosaveDocumentObservation<T> {
  projectId: string;
  doc: T;
}

/**
 * Hydration establishes the baseline for a project. Only a later document
 * identity from the same project represents an edit that should be autosaved.
 */
export function pendingAutosaveAfterObservation<T>(
  previous: AutosaveDocumentObservation<T> | null,
  next: AutosaveDocumentObservation<T>,
): AutosaveDocumentObservation<T> | null {
  if (previous === null || previous.projectId !== next.projectId || previous.doc === next.doc) return null;
  return next;
}

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
