import {
  clearStoredToolAttempt,
  type StoredToolAttempt,
} from './serverRunSessionStorage';
import {
  scheduleServerRunToolResultRetry,
  type ToolClaimResponse,
} from './serverRunToolTransport';
import {
  withServerRunToolLock,
  type ServerRunLockManager,
} from './serverRunToolLock';

export interface RecoveredServerTool {
  readonly name?: string;
  readonly argsDigest: string;
  readonly result?: unknown;
  readonly error?: string;
}

interface ReconcileStoredToolAttemptsInput {
  readonly projectId: string;
  readonly runId: string;
  readonly attempts: readonly StoredToolAttempt[];
  readonly lockManager: ServerRunLockManager | null;
  readonly active: () => boolean;
  readonly claim: (attempt: StoredToolAttempt) => Promise<ToolClaimResponse | null>;
  readonly recovered: (toolCallId: string) => RecoveredServerTool | undefined;
  readonly post: (
    toolCallId: string,
    outcome: RecoveredServerTool,
  ) => Promise<boolean>;
}

function recoveredOutcome(
  attempt: StoredToolAttempt,
  recovered: RecoveredServerTool | undefined,
): RecoveredServerTool {
  if (recovered?.argsDigest === attempt.argsDigest) return recovered;
  if (attempt.status === 'result') {
    return {
      name: attempt.name,
      argsDigest: attempt.argsDigest,
      result: attempt.result,
    };
  }
  if (attempt.status === 'error') {
    return {
      name: attempt.name,
      argsDigest: attempt.argsDigest,
      error: attempt.error,
    };
  }
  return {
    argsDigest: attempt.argsDigest,
    error: recovered
      ? 'Recovered tool arguments do not match the server request.'
      : 'Browser reloaded after this tool began; the operation was not replayed automatically.',
  };
}

async function reconcileAttempt(
  input: ReconcileStoredToolAttemptsInput,
  attempt: StoredToolAttempt,
): Promise<boolean> {
  const claim = await input.claim(attempt);
  if (!claim) return false;
  if (!claim.claimed) {
    return claim.outcome === 'run-settled' || claim.outcome === 'run-stale';
  }
  return input.post(
    attempt.toolCallId,
    recoveredOutcome(attempt, input.recovered(attempt.toolCallId)),
  );
}

export async function reconcileStoredServerRunToolAttempts(
  input: ReconcileStoredToolAttemptsInput,
): Promise<void> {
  await Promise.all(input.attempts.map(async (attempt) => {
    const post = async (): Promise<boolean> => {
      const locked = await withServerRunToolLock(
        input.lockManager,
        input.projectId,
        input.runId,
        attempt.toolCallId,
        () => reconcileAttempt(input, attempt),
      );
      return locked.acquired && locked.value;
    };
    const settle = (): void => clearStoredToolAttempt(input.projectId, attempt.toolCallId);
    if (await post()) settle();
    else scheduleServerRunToolResultRetry(post, settle, input.active);
  }));
}
