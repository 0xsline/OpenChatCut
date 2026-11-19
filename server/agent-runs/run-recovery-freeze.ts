import { flushRunPersistence, pushRunEvent, type ServerRun } from './store';
import { isRunRecoveryFault } from './run-recovery-fault';
import { markRunRecoveryNeedsReconcile, stopRunRecoveryRuntime } from './run-recovery-runtime';

/**
 * Terminates an agent turn that can no longer prove what it wrote, without
 * pretending the run failed.
 *
 * The distinction matters for correctness: `failed` + `done` closes the run, the
 * browser drops its draft and capabilities, and the next process has nothing
 * left to reconcile against — while the browser-side edit may well exist. A
 * frozen run keeps its capability, draft and tool records, reports which
 * operation is unresolved, and waits for a verifiable result or an explicit
 * user decision.
 */
export async function settleRunRecoveryFault(run: ServerRun, fault: Error): Promise<void> {
  markRunRecoveryNeedsReconcile(run, fault);
  run.error = fault.message;
  try {
    pushRunEvent(run, 'recovery-blocked', {
      code: isRunRecoveryFault(fault) ? fault.code : 'recovery-write-failed',
      message: fault.message,
    });
    await flushRunPersistence(run);
  } catch {
    // The event window is full. The frozen executor and the durable
    // `needs_reconcile` phase are the authoritative record; losing the
    // diagnostic event must not turn into a terminal write.
  } finally {
    stopRunRecoveryRuntime(run);
  }
}
