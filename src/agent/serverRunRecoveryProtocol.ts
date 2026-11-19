export const SERVER_RUN_CAPABILITY_HEADER = 'X-OpenChatCut-Run-Capability';

/** The durable recovery view for a server run that supports restart. */
export interface ServerRunRecoveryMetadata {
  readonly state: 'admitted' | 'active' | 'waiting_reconcile' | 'ready' | 'paused' | 'finalized';
  readonly revision: number;
  readonly attemptNumber?: number;
  readonly lastError?: string | null;
  readonly lastContinuationId?: string | null;
  readonly requestIndex?: number;
  readonly lastEventId?: number;
  /**
   * Display baseline the server can vouch for. Present when the browser's cursor
   * cannot be honoured: the events it skipped are gone, so the UI has to adopt
   * this state instead of pretending the run just started.
   */
  readonly replayBase?: {
    readonly firstEventId: number;
    readonly lastEventId: number;
    readonly revision: number;
    readonly resetsCursor: boolean;
    readonly terminalText: string | null;
  };
  readonly tools?: readonly {
    readonly toolCallId: string;
    readonly name: string;
    readonly argsDigest: string;
    readonly opSeq?: number;
    readonly state?: 'intent' | 'claimed' | 'outcome';
    readonly result?: unknown;
    readonly error?: string;
  }[];
}

export interface ServerRunMetadata {
  readonly status?: 'created' | 'running' | 'awaiting-confirmation'
    | 'awaiting-user' | 'paused' | 'completed' | 'failed' | 'cancelled';
  readonly firstEventId?: number;
  readonly lastEventId?: number;
  readonly recovery?: ServerRunRecoveryMetadata;
}

/**
 * True when the run needs the resume handshake instead of the ordinary
 * reconnect. `admitted` means the browser never started it, which keeps the
 * original admission path (and its 60s deadline) intact.
 */
export function serverRunNeedsResume(
  metadata: ServerRunMetadata,
): boolean {
  const state = metadata.recovery?.state;
  return state === 'ready' || state === 'waiting_reconcile';
}

/**
 * The cursor a resumed browser may start from.
 *
 * When the stored cursor is behind the replay window (or the server publishes a
 * baseline for it), the only honest answer is the baseline's own watermark:
 * asking for a lower id would be rejected 410, and jumping to the newest id
 * would silently drop the events in between.
 */
export function serverRunResumeCursor(
  metadata: ServerRunMetadata,
  storedCursor: number,
): { readonly cursor: number; readonly adoptedBaseline: boolean; readonly reason?: string } {
  const base = metadata.recovery?.replayBase;
  if (!base) return { cursor: storedCursor, adoptedBaseline: false };
  if (storedCursor < base.firstEventId - 1) {
    return {
      cursor: base.lastEventId,
      adoptedBaseline: true,
      reason: '服务端事件已超出可恢复窗口，已按服务端的显示基线恢复。',
    };
  }
  if (storedCursor > base.lastEventId) {
    // The browser claims to have seen events the server never wrote. Trusting
    // that would skip real work, so the baseline wins and the mismatch is shown.
    return {
      cursor: base.lastEventId,
      adoptedBaseline: true,
      reason: '本地记录的事件位置超过了服务端水位，已按服务端显示基线恢复。',
    };
  }
  return { cursor: storedCursor, adoptedBaseline: false };
}

export function serverRunRecoveryBlocked(
  metadata: ServerRunMetadata,
): boolean {
  return metadata.recovery?.state === 'waiting_reconcile';
}

/** The reconciliation facts a resume has to report before it may start. */
export function serverRunUnreconciledTools(
  metadata: ServerRunMetadata,
): NonNullable<ServerRunRecoveryMetadata['tools']> {
  return (metadata.recovery?.tools ?? []).filter((tool) => tool.state !== 'outcome');
}

/**
 * Requests execution authority for a recovered run.
 *
 * `expectedRevision` is the revision the browser reconciled against. The server
 * re-reads its own durable state and refuses with a reason when the browser is
 * behind, when another executor holds the run, or when tools are unreconciled;
 * a bare 202 is the only answer that grants authority.
 */
export async function requestServerRunResume(
  projectId: string,
  runId: string,
  capability: string,
  input: { readonly expectedRevision: number; readonly recorderId: string; readonly cursor: number },
): Promise<{ readonly ok: boolean; readonly status: number; readonly reason?: string }> {
  const response = await fetch(`/api/agent-runs/${runId}/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SERVER_RUN_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({
      projectId,
      mode: 'resume',
      expectedRevision: input.expectedRevision,
      recorderId: input.recorderId,
      cursor: input.cursor,
    }),
  });
  if (response.status === 202) return { ok: true, status: response.status };
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return {
    ok: false,
    status: response.status,
    reason: typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
  };
}
