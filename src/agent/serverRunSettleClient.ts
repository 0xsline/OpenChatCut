import type { ProposalRuntimeStatus } from './runtime-ledger';

export interface ServerRunSettleClientInput {
  readonly status: 'completed' | 'failed' | 'aborted' | 'interrupted'
    | 'waiting_approval' | 'awaiting_user';
  readonly proposalId?: string;
  readonly proposalRuntimeStatus?: ProposalRuntimeStatus;
  readonly summary?: string;
}

/**
 * Browser-side terminal settlement for a server run. The server owns the
 * sidecar now; this is the only write the browser performs for run
 * lifecycle, and it is idempotent and best-effort (a missing or already
 * terminal run is not an error; the next hydration recovery cleans up).
 */
export async function settleServerRun(
  projectId: string,
  runId: string,
  input: ServerRunSettleClientInput,
): Promise<void> {
  try {
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...input }),
    });
    if (response.ok) return;
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (payload?.error === 'invalid settle status') {
      throw new Error(`server run settle rejected: ${payload.error}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('server run settle rejected')) throw error;
    // Transport or admission failure: the run record stays for hydration
    // recovery, which settles it on the next open.
  }
}
