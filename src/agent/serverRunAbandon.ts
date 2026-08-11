import { resumeAgentRun, type AgentRunRecorder } from './runtime-ledger';
import { requestServerRunCancellation } from './serverRunProtocol';

interface AbandonedServerRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly capability: string | null;
  readonly leaseToken?: string;
  readonly recorder: AgentRunRecorder | null;
  readonly summary: string;
}

/** Settles the owned local ledger before browser recovery authority is discarded. */
export async function settleAbandonedServerRun(
  input: AbandonedServerRunInput,
): Promise<string | null> {
  const recorder = input.recorder
    ?? await resumeAgentRun(input.projectId, input.runId, input.leaseToken);
  if (!recorder) {
    throw new Error('Agent run ownership could not be proved; recovery authority was retained.');
  }
  let transportWarning: string | null = null;
  if (input.capability) {
    try {
      await requestServerRunCancellation(input.projectId, input.runId, input.capability);
    } catch (error) {
      transportWarning = error instanceof Error ? error.message : String(error);
    }
  }
  await recorder.finalize('interrupted', input.summary);
  return transportWarning;
}
