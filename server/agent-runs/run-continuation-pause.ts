import { redactTextForAgentRuntime } from '../../src/agent/runtime-artifact';
import { flushRunPersistence, isRunTerminal, pushRunEvent, setRunStatus, type ServerRun } from './store';
import { runRecoveryStore } from './run-recovery-store';
import { pauseRunRecovery, runRecoveryKeyOf } from './run-recovery-runtime';
import { asRecoveryFault } from './run-recovery-fault';
import { settleRunRecoveryFault } from './run-recovery-freeze';

/** A failed execution attempt keeps the logical task open for the user's next instruction. */
export async function pauseInterruptedRun(run: ServerRun, abort: AbortController, error: unknown): Promise<boolean> {
  if (isRunTerminal(run) || run.terminalPromise || run.persistenceError
    || (abort.signal.aborted && run.error === 'Agent run cancelled.')) return false;
  const record = runRecoveryStore().load(runRecoveryKeyOf(run));
  if (!record || record.phase === 'finalized') return false;
  const message = safeRunError(error);
  try {
    pauseRunRecovery(run, message);
  } catch (failure) {
    await settleRunRecoveryFault(run, asRecoveryFault(failure));
    return true;
  }
  run.error = message;
  await setRunStatus(run, 'paused');
  pushRunEvent(run, 'run-paused', { error: message, attemptNumber: record.attemptNumber });
  await flushRunPersistence(run);
  return true;
}

export function safeRunError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactTextForAgentRuntime(raw).trim().slice(0, 1_200)
    || 'Agent provider request failed.';
}

export async function settleRunFailure(
  run: ServerRun,
  abort: AbortController,
  error: unknown,
): Promise<void> {
  const cancelled = run.status === 'cancelled'
    || (abort.signal.aborted
      && run.status !== 'failed'
      && run.error === 'Agent run cancelled.');
  const message = cancelled ? 'Agent run cancelled.' : safeRunError(error);
  run.error = message;
  if (!run.persistenceError) {
    try {
      pushRunEvent(run, 'error', { message });
    } catch {
      // The event-cap path already scheduled a failed transport settlement.
    }
  }
  await setRunStatus(run, cancelled ? 'cancelled' : 'failed').catch(() => undefined);
}
