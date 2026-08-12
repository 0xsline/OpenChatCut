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
      transportWarning = error instanceof Error ? error.message : String(error);
    }
  }
  await settleServerRun(input.projectId, input.runId, {
    status: 'interrupted',
    summary: input.summary,
  });
  return transportWarning;
}
