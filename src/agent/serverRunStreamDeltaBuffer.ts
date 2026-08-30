import {
  patchStoredServerRun,
  readStoredServerRun,
  type StoredServerRun,
} from './serverRunSessionStorage';

/**
 * Batches streaming text/thinking persistence for server runs.
 *
 * Persisting every SSE delta rewrites the full localStorage run record
 * (read + parse + stringify + verify) — O(text²) over a long reply, on the
 * main thread. Recovery replays events after the stored cursor, so writing a
 * consistent (cursor, text) snapshot every STREAM_DELTA_FLUSH_MS keeps the
 * durability contract while cutting writes to a few per second.
 *
 * Consistency rules:
 * - cursor and accumulated text always land in the same patch;
 * - non-delta commits fold any pending snapshot into their own patch
 *   (takePendingStreamDeltaPatch) so the stored cursor never runs ahead of
 *   the stored text;
 * - a deferred flush failure reports through onFlushFailure exactly like a
 *   synchronous 'failed' commit; a flush for a run that no longer owns the
 *   stored record is discarded, never written across runs.
 */

type StreamDeltaFields = Partial<Pick<StoredServerRun, 'assistantText' | 'assistantThinking'>>;

interface PendingStreamDelta {
  readonly runId: string;
  readonly cursor: number;
  readonly fields: StreamDeltaFields;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onFlushFailure: (runId: string) => void;
}

const STREAM_DELTA_FLUSH_MS = 200;
const pendingByProject = new Map<string, PendingStreamDelta>();

function clearPending(projectId: string): PendingStreamDelta | undefined {
  const pending = pendingByProject.get(projectId);
  if (!pending) return undefined;
  clearTimeout(pending.timer);
  pendingByProject.delete(projectId);
  return pending;
}

function flushPending(projectId: string): void {
  const pending = clearPending(projectId);
  if (!pending) return;
  // The record may have been cleared or replaced by a newer run while the
  // flush was pending — discard instead of writing across runs.
  if (readStoredServerRun(projectId)?.runId !== pending.runId) return;
  if (patchStoredServerRun(projectId, { cursor: pending.cursor, ...pending.fields })) return;
  pending.onFlushFailure(pending.runId);
}

/** Queue a consistent (cursor, text) snapshot; persisted after a short delay. */
export function queueStreamDeltaPatch(
  projectId: string,
  runId: string,
  cursor: number,
  fields: StreamDeltaFields,
  onFlushFailure: (runId: string) => void,
): void {
  const existing = pendingByProject.get(projectId);
  if (existing && existing.runId === runId) {
    pendingByProject.set(projectId, {
      ...existing,
      cursor,
      fields: { ...existing.fields, ...fields },
      onFlushFailure,
    });
    return;
  }
  if (existing) clearPending(projectId);
  pendingByProject.set(projectId, {
    runId,
    cursor,
    fields,
    timer: setTimeout(() => flushPending(projectId), STREAM_DELTA_FLUSH_MS),
    onFlushFailure,
  });
}

/**
 * Merge-and-clear for non-delta commits: returns the pending text fields to
 * fold into the caller's own patch (the caller writes a newer cursor in the
 * same write). Pending state from another run is discarded, never returned.
 */
export function takePendingStreamDeltaPatch(
  projectId: string,
  runId: string | null,
): StreamDeltaFields {
  const pending = clearPending(projectId);
  if (!pending || pending.runId !== runId) return {};
  return pending.fields;
}

/** Discard any pending snapshot without writing (run finished or abandoned). */
export function dropStreamDeltas(projectId: string): void {
  clearPending(projectId);
}
