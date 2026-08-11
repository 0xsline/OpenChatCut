import { loadAgentRuntimeSidecar } from '../persist/agentRuntimeStore';
import { resumeAgentRun, type AgentRunRecorder } from './runtime-ledger';
import {
  loadServerRunMetadata,
  restoreServerRunToolActivation,
  type ServerRunMetadata,
} from './serverRunProtocol';
import {
  patchStoredServerRun,
  type StoredServerRun,
} from './serverRunSessionStorage';
import type { ToolActivation } from './tool-activation';
import {
  permanentServerRunRecoveryError,
  recoveredRunAwaitsProposal,
} from './serverRunRecovery';
import {
  acquireServerRunOwnership,
  releaseServerRunOwnership,
} from './serverRunOwnership';

export type ServerRunRecoveryPreparation =
  | { readonly kind: 'inactive' }
  | { readonly kind: 'owned_elsewhere' }
  | { readonly kind: 'local_terminal' }
  | { readonly kind: 'proposal' }
  | {
    readonly kind: 'active';
    readonly capability: string;
    readonly activation: ToolActivation;
    readonly cursor: number;
    readonly metadata: ServerRunMetadata;
    readonly recorder: AgentRunRecorder;
  };

function validateCursor(metadata: ServerRunMetadata, cursor: number): void {
  if (typeof metadata.firstEventId === 'number' && cursor < metadata.firstEventId - 1) {
    throw permanentServerRunRecoveryError('服务端任务事件已超出可恢复窗口。');
  }
}

async function claimRecorder(
  projectId: string,
  stored: StoredServerRun,
): Promise<AgentRunRecorder | null> {
  if (!await acquireServerRunOwnership(projectId, stored.runId)) return null;
  const recorder = await resumeAgentRun(projectId, stored.runId, stored.leaseToken);
  if (recorder) return recorder;
  releaseServerRunOwnership(projectId, stored.runId);
  throw new Error('Server run recorder ownership could not be recovered.');
}

export async function prepareServerRunRecovery(
  projectId: string,
  stored: StoredServerRun,
  active: () => boolean,
): Promise<ServerRunRecoveryPreparation> {
  const capability = stored.capability;
  if (!capability) {
    throw permanentServerRunRecoveryError('Stored server run capability is unavailable.');
  }
  const activation = restoreServerRunToolActivation(stored.askOnly === true, stored.activeToolNames);
  if (!activation) {
    throw permanentServerRunRecoveryError('Stored server run has an invalid active tool set.');
  }
  const metadata = await loadServerRunMetadata(projectId, stored.runId, capability);
  if (!active()) return { kind: 'inactive' };
  const cursor = stored.cursor ?? 0;
  validateCursor(metadata, cursor);
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const run = sidecar.runs.find((candidate) => candidate.runId === stored.runId);
  if (!run) {
    throw permanentServerRunRecoveryError(
      'Server run recorder state is unavailable for the current session generation.',
    );
  }
  if (['completed', 'failed', 'aborted', 'interrupted'].includes(run.status)) {
    return { kind: 'local_terminal' };
  }
  const recorder = await claimRecorder(projectId, stored);
  if (!recorder) return { kind: 'owned_elsewhere' };
  if (recoveredRunAwaitsProposal(run)) {
    await recorder.releaseLease();
    releaseServerRunOwnership(projectId, stored.runId);
    return { kind: 'proposal' };
  }
  if (run.status === 'waiting_approval') await recorder.cancelPendingApprovalsOnHydration();
  if (!stored.leaseToken && !patchStoredServerRun(projectId, {
    leaseToken: recorder.recoveryLeaseToken(),
  })) throw new Error('Browser durable storage could not update recovery ownership.');
  return { kind: 'active', activation, capability, cursor, metadata, recorder };
}
