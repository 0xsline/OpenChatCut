import type { ExternalEditSession } from '../../src/agent/external-edit-session.ts';
import { ExternalSessionRunLedger } from '../../src/agent/external-run-ledger.ts';
import { currentAgentRunOwnerInstanceId } from '../../src/agent/runtime-ledger.ts';
import { agentRuntimeKey, loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore.ts';
import {
  adoptAgentSessionWriteGeneration,
  currentAgentSessionGeneration,
} from '../../src/persist/agentSessionGeneration.ts';
import { kvUpdateAgentRunLease } from '../../src/persist/sharedKv.ts';
import { ExternalEditorCallError } from './broker.ts';
import { activateOfflineAgentRuntimeBackend } from './agent-runtime-persistence.ts';

const RESUMABLE_STATUS: Record<string, true> = {
  running: true,
  waiting_approval: true,
  awaiting_user: true,
};
const SERVER_LEASE_MS = 120_000;

export async function openOfflineSessionRun(
  projectId: string,
  session: ExternalEditSession,
  resumedCheckpoint: boolean,
): Promise<ExternalSessionRunLedger> {
  activateOfflineAgentRuntimeBackend();
  const generation = await currentAgentSessionGeneration(projectId);
  adoptAgentSessionWriteGeneration(projectId, generation);
  if (resumedCheckpoint) {
    const sidecar = await loadAgentRuntimeSidecar(projectId);
    const persisted = sidecar.runs.find((run) => (
      run.externalSessionId === session.id
      && run.backend === 'external-offline'
      && RESUMABLE_STATUS[run.status] === true
    ));
    if (persisted) {
      const claimed = await kvUpdateAgentRunLease({
        operation: 'agent-run-lease',
        key: agentRuntimeKey(projectId, sidecar.sessionGeneration),
        runId: persisted.runId,
        action: 'claim',
        ownerInstanceId: currentAgentRunOwnerInstanceId(),
        leaseMs: SERVER_LEASE_MS,
      });
      const resumed = claimed?.accepted && claimed.lease
        ? await ExternalSessionRunLedger.resume(
          projectId,
          persisted.runId,
          undefined,
          claimed.lease.leaseToken,
        )
        : null;
      if (resumed) return resumed;
      throw new ExternalEditorCallError(
        'stale',
        `Offline Agent run ${persisted.runId} is owned by another active process.`,
      );
    }
  }
  return ExternalSessionRunLedger.start(
    projectId,
    session.clientName,
    session.id,
    'external-offline',
  );
}
