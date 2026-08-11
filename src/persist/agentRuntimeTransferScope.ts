import type {
  AgentRunStatus,
  AgentRuntimeSidecar,
  AgentRuntimeSnapshot,
} from './agentRuntimeStore';
import type { StoredProposalRecord } from './proposalStore';

const PROJECT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const TERMINAL_RUN_STATUS: Partial<Record<AgentRunStatus, true>> = {
  completed: true, failed: true, aborted: true, interrupted: true,
};
const ACTIVE_RUN_STATUS: Partial<Record<AgentRunStatus, true>> = {
  running: true, waiting_approval: true, awaiting_user: true,
};
function portableRunContext(
  context: AgentRuntimeSidecar['runs'][number]['context'],
): AgentRuntimeSidecar['runs'][number]['context'] {
  if (!context) return undefined;
  const {
    serverRunCapabilityVerifier: _capability,
    transportStatus: _status,
    transportError: _error,
    ...portable
  } = context;
  return portable;
}
function portableRunEvent(
  event: AgentRuntimeSidecar['runs'][number]['events'][number],
): AgentRuntimeSidecar['runs'][number]['events'][number] {
  return {
    ...event,
    ...(event.context ? { context: portableRunContext(event.context) } : {}),
  };
}
function portableArtifacts(snapshot: AgentRuntimeSnapshot): {
  readonly artifacts: AgentRuntimeSnapshot['artifacts'];
  readonly excludedIds: ReadonlySet<string>;
} {
  const excludedIds = new Set(
    snapshot.artifacts
      .filter((artifact) => artifact.kind === 'server-run-draft')
      .map((artifact) => artifact.artifactId),
  );
  return {
    artifacts: snapshot.artifacts.filter((artifact) => !excludedIds.has(artifact.artifactId)),
    excludedIds,
  };
}




export function validateProposalRuntimeTransfer(
  snapshot: AgentRuntimeSnapshot | null,
  proposal: StoredProposalRecord | undefined,
): void {
  if (!proposal) {
    const dangling = snapshot?.sidecar.runs.some(
      (run) => !TERMINAL_RUN_STATUS[run.status] && run.proposalIds.length > 0,
    );
    if (dangling) throw new Error('Pending proposal payload closure is incomplete.');
    return;
  }
  if (proposal.phase === 'settled' || !proposal.proposal.agentRunId) return;
  const run = snapshot?.sidecar.runs.find(
    (candidate) => candidate.runId === proposal.proposal.agentRunId,
  );
  if (!run || !proposal.proposal.id || !run.proposalIds.includes(proposal.proposal.id)
    || TERMINAL_RUN_STATUS[run.status]) {
    throw new Error('Pending proposal runtime closure is incomplete.');
  }
}

/** Export-only projection: portable packages never carry live runtime authority. */
export function projectPortableAgentRuntimeSnapshot(
  snapshot: AgentRuntimeSnapshot,
): AgentRuntimeSnapshot {
  const { sessionGeneration: _sessionGeneration, ...portableSidecar } = snapshot.sidecar;
  const { artifacts, excludedIds } = portableArtifacts(snapshot);
  return {
    sidecar: {
      ...portableSidecar,
      artifacts: portableSidecar.artifacts.filter(
        (artifact) => !excludedIds.has(artifact.artifactId),
      ),
      runs: snapshot.sidecar.runs.map((source) => {
        const {
          ownerInstanceId: _owner,
          leaseToken: _token,
          leaseExpiresAt: _lease,
          externalSessionId: _externalSession,
          context,
          ...run
        } = source;
        return {
          ...run,
          artifactIds: run.artifactIds.filter((artifactId) => !excludedIds.has(artifactId)),
          events: run.events.map(portableRunEvent),
          ...(context ? { context: portableRunContext(context) } : {}),
        };
      }),
    },
    artifacts,
  };
}

function rescopeRun(
  source: AgentRuntimeSidecar['runs'][number],
  projectId: string,
  pendingRunId: string | undefined,
  pendingProposalId: string | undefined,
  importedAt: number,
): AgentRuntimeSidecar['runs'][number] {
  const {
    ownerInstanceId: _owner,
    leaseToken: _token,
    leaseExpiresAt: _lease,
    context,
    ...run
  } = source;
  // External session IDs are immutable audit linkage, not resumable ownership authority.
  const active = ACTIVE_RUN_STATUS[run.status] === true;
  const preserved = run.runId === pendingRunId
    && !!pendingProposalId && run.proposalIds.includes(pendingProposalId);
  return {
    ...run,
    projectId,
    ...(context ? { context: portableRunContext(context) } : {}),
    status: preserved ? 'waiting_approval' : active ? 'interrupted' : run.status,
    ...(active && !preserved
      ? { updatedAt: importedAt, finalSummary: 'Interrupted by project transfer import.' }
      : {}),
    events: run.events.map((event) => ({ ...portableRunEvent(event), projectId })),
  };
}

export function rescopeAgentRuntimeSnapshot(
  snapshot: AgentRuntimeSnapshot,
  projectId: string,
  proposal?: StoredProposalRecord,
): AgentRuntimeSnapshot {
  if (!PROJECT_ID.test(projectId)) throw new Error('Invalid imported Agent runtime project id.');
  validateProposalRuntimeTransfer(snapshot, proposal);
  const pendingRunId = proposal?.phase !== 'settled' ? proposal?.proposal.agentRunId : undefined;
  const pendingProposalId = proposal?.phase !== 'settled' ? proposal?.proposal.id : undefined;
  const importedAt = Date.now();
  const sidecar: AgentRuntimeSidecar = {
    ...snapshot.sidecar,
    projectId,
    runs: snapshot.sidecar.runs.map((run) => (
      rescopeRun(run, projectId, pendingRunId, pendingProposalId, importedAt)
    )),
    approvals: snapshot.sidecar.approvals.map((row) => ({
      ...row,
      projectId,
      ...(row.status === 'pending' ? {
        status: 'cancelled' as const,
        decidedAt: importedAt,
        summary: row.summary ?? 'Cancelled by project transfer import.',
      } : {}),
    })),
    checkpoints: snapshot.sidecar.checkpoints.map((row) => ({ ...row, projectId })),
    artifacts: snapshot.sidecar.artifacts.map((row) => ({ ...row, projectId })),
  };
  return { sidecar, artifacts: snapshot.artifacts.map((row) => ({ ...row, projectId })) };
}
