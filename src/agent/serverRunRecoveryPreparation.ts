import { loadAgentRuntimeSidecar } from '../persist/agentRuntimeStore';
import {
  loadServerRunMetadata,
  restoreServerRunToolActivation,
  type ServerRunMetadata,
} from './serverRunProtocol';
import type { StoredServerRun } from './serverRunSessionStorage';
import type { ToolActivation } from './tool-activation';
import {
  serverRunNeedsResume,
  serverRunResumeCursor,
} from './serverRunProtocol';

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
  | { readonly kind: 'local_terminal'; readonly metadata: ServerRunMetadata }
  | { readonly kind: 'proposal' }
  | {
    readonly kind: 'active';
    readonly capability: string;
    readonly activation: ToolActivation;
    readonly cursor: number;
    readonly metadata: ServerRunMetadata;
    /**
     * Present when the server can resume the interrupted run. The browser must
     * reconcile its local evidence and post the resume handshake before the run
     * gets execution authority again.
     */
    readonly baselineNotice?: string;
    readonly resume?: {
      readonly revision: number;
    };
  };

function validateCursor(metadata: ServerRunMetadata, cursor: number): void {
  if (typeof metadata.firstEventId === 'number' && cursor < metadata.firstEventId - 1) {
    throw permanentServerRunRecoveryError('服务端任务事件已超出可恢复窗口。');
  }
}

async function claimRecorder(projectId: string, runId: string): Promise<boolean> {
  // The server owns the sidecar; the browser only fences its own recovery
  // with a local lock so a second tab does not replay the same run.
  return acquireServerRunOwnership(projectId, runId);
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
  const storedCursor = stored.cursor ?? 0;
  // A cursor outside the replay window is not fatal for a resumable run: the
  // server publishes a baseline, and the browser continues from that watermark
  // instead of asking for events that no longer exist.
  const resumeCursor = serverRunResumeCursor(metadata, storedCursor);
  const cursor = resumeCursor.cursor;
  if (!resumeCursor.adoptedBaseline) validateCursor(metadata, cursor);
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const run = sidecar.runs.find((candidate) => candidate.runId === stored.runId);
  if (!run) {
    throw permanentServerRunRecoveryError(
      'Server run recorder state is unavailable for the current session generation.',
    );
  }
  if (['completed', 'failed', 'aborted', 'interrupted'].includes(run.status)) {
    return { kind: 'local_terminal', metadata };
  }
  if (!await claimRecorder(projectId, stored.runId)) return { kind: 'owned_elsewhere' };
  if (recoveredRunAwaitsProposal(run)) {
    releaseServerRunOwnership(projectId, stored.runId);
    return { kind: 'proposal' };
  }
  const resume = serverRunNeedsResume(metadata)
    ? {
      revision: metadata.recovery!.revision,
    }
    : undefined;
  return {
    kind: 'active',
    activation,
    capability,
    cursor,
    metadata,
    ...(resume ? { resume } : {}),
    ...(resumeCursor.adoptedBaseline && resumeCursor.reason
      ? { baselineNotice: resumeCursor.reason }
      : {}),
  };
}
