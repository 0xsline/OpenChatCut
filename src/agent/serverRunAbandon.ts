import { settleServerRun } from './serverRunSettleClient';
import { requestServerRunCancellation } from './serverRunProtocol';

interface AbandonedServerRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly capability: string | null;
  readonly summary: string;
}

/** Settles the run ledger on the server before browser recovery authority is discarded. */
export async function settleAbandonedServerRun(
  input: AbandonedServerRunInput,
): Promise<string | null> {
  let transportWarning: string | null = null;
  if (input.capability) {
    try {
      await requestServerRunCancellation(input.projectId, input.runId, input.capability);
    } catch (error) {
      // 404 means the run no longer exists server-side (e.g. after a server
      // restart): the cleanup goal is already met, so it is not a warning.
      if ((error as { status?: number }).status !== 404) {
        transportWarning = error instanceof Error ? error.message : String(error);
      }
    }
  }
  await settleServerRun(input.projectId, input.runId, {
    status: 'interrupted',
    summary: input.summary,
  });
  return transportWarning;
}
