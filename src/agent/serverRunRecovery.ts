import type { DisplayMessage } from './agent-session';
import type { RecoveredServerTool } from './serverRunToolExecutor';
import { settleServerRun } from './serverRunSettleClient';
import type {
  ServerRunSession,
  ServerRunTerminal,
  ServerRunTerminalDisposition,
  ServerRunTerminalResolution,
} from './serverRunProtocol';
import {
  clearStoredServerRun,
  readStoredServerRun,
  type StoredServerRun,
} from './serverRunSessionStorage';

export const serverRunRecoveryDelay = (attempt: number): number =>
  Math.min(30_000, 500 * (2 ** Math.min(Math.max(0, attempt), 6)));
export function storedServerRunPreservesHydration(
  stored: StoredServerRun | null,
): stored is StoredServerRun {
  // A stored run with a capability is a live server run: preserve it
  // through hydration unconditionally. The browser no longer writes lease
  // tokens (single-writer), so requiring one here would interrupt every
  // active run on reload or second-tab open.
  return !!stored?.capability;
}

const SERVER_RUN_ADMISSION_GRACE_MS = 30_000;

export function shouldRetryPendingServerRunAdmission(
  stored: StoredServerRun,
  error: unknown,
  now = Date.now(),
): boolean {
  const status = error && typeof error === 'object'
    ? (error as { readonly status?: unknown }).status
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const age = typeof stored.createdAt === 'number' ? now - stored.createdAt : Number.POSITIVE_INFINITY;
  return stored.admissionPending === true
    && age >= 0
    && age <= SERVER_RUN_ADMISSION_GRACE_MS
    && (status === 404 || /\bHTTP 404\b/.test(message));
}

export class PermanentServerRunRecoveryError extends Error {
  readonly permanent = true;
}

export function permanentServerRunRecoveryError(message: string): Error {
  return new PermanentServerRunRecoveryError(message);
}

export function isPermanentServerRunRecoveryError(error: unknown): boolean {
  if (error instanceof PermanentServerRunRecoveryError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    readonly status?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
  if (candidate.status === 403
    || candidate.status === 404
    || candidate.status === 410) return true;
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return /generation(?:_|-)?mismatch|session(?:_|-)?generation(?:_|-)?(?:changed|invalid)/i.test(code)
    || /\bHTTP (?:403|404|410)\b|session generation (?:mismatch|changed|is invalid)/i.test(message);
}

export function restoredRunMessages(
  current: DisplayMessage[],
  text: string,
  assistantText: string,
): DisplayMessage[] {
  const last = current.at(-1);
  const previous = current.at(-2);
  if (last?.role === 'assistant' && last.text === ''
    && previous?.role === 'user' && previous.text === text) {
    return [...current.slice(0, -1), { ...last, text: assistantText }];
  }
  if (last?.role === 'user' && last.text === text) {
    return [...current, { role: 'assistant', text: assistantText }];
  }
  return [
    ...current,
    { role: 'user', text },
    { role: 'assistant', text: assistantText },
  ];
}

export function recoveredToolMap(
  tools: readonly (RecoveredServerTool & { readonly toolCallId: string })[],
): Map<string, RecoveredServerTool> {
  return new Map(tools.map((tool) => [tool.toolCallId, tool]));
}

export function appendStreamingMessage(
  current: DisplayMessage[],
  delta: string,
): DisplayMessage[] {
  const last = current.at(-1);
  return last?.role === 'assistant'
    ? [...current.slice(0, -1), { ...last, text: last.text + delta }]
    : [...current, { role: 'assistant', text: delta }];
}

export function recoveredRunAwaitsProposal(
  run: { readonly status: string; readonly proposalIds: readonly string[] },
): boolean {
  return run.status === 'waiting_approval' && run.proposalIds.length > 0;
}

interface FinishRecoveredRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly status: ServerRunTerminal['status'];
  readonly assistantText: string;
  readonly commitModelTurn?: ServerRunSession['commitModelTurn'];
  readonly onTerminal?: (
    terminal: ServerRunTerminal,
  ) => ServerRunTerminalResolution | false | Promise<ServerRunTerminalResolution | false>;
}

export async function finishRecoveredRun(
  input: FinishRecoveredRunInput,
): Promise<ServerRunTerminalDisposition | false> {
  const stored = readStoredServerRun(input.projectId);
  const resolution = await input.onTerminal?.({
    runId: input.runId,
    status: input.status,
    assistantText: input.assistantText,
  }) ?? false;
  let disposition: ServerRunTerminalDisposition | false;
  if (resolution && typeof resolution === 'object') disposition = resolution.disposition;
  else disposition = resolution;
  if (!disposition) {
    await settleServerRun(input.projectId, input.runId, {
      // The server settle endpoint does not accept 'awaiting_user' (it is
      // a transient end-of-turn status); a recovered run awaiting user
      // input is final as far as the ledger is concerned.
      status: input.status === 'cancelled' ? 'aborted'
        : input.status === 'awaiting_user' ? 'completed' : input.status,
      summary: input.assistantText || 'server run recovered terminal',
    });
    disposition = 'finalized';
  }
  if (disposition && stored?.content) {
    await input.commitModelTurn?.(
      input.runId,
      stored.modelHistoryLength ?? Number.MAX_SAFE_INTEGER,
      stored.content,
      input.assistantText,
    );
  }
  if (resolution && typeof resolution === 'object') {
    await resolution.afterModelCommit();
  }
  if (disposition === 'finalized') {
    clearStoredServerRun(input.projectId, input.runId);
  }
  return disposition;
}
