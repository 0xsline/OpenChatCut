import type {
  AgentApprovalRecord,
  AgentCheckpointRecord,
  AgentRunEvent,
  AgentRunRecord,
  AgentRunStatus,
  AgentRuntimeSidecar,
} from './agentRuntimeStore';

export const MAX_AGENT_RUNS = 30;
export const MAX_EVENTS_PER_RUN = 192;
export const MAX_APPROVALS = 100;
export const MAX_CHECKPOINTS = 8;

const ACTIVE_STATUS: Partial<Record<AgentRunStatus, true>> = {
  running: true, waiting_approval: true, awaiting_user: true,
};
const CRITICAL_EVENT: Partial<Record<AgentRunEvent['type'], true>> = {
  tool_requested: true, tool_started: true, tool_outcome: true,
  proposal_applied: true, proposal_rejected: true, proposal_stale: true,
  proposal_reproposed: true, final: true,
};
const terminal = (status: AgentRunStatus): boolean => ACTIVE_STATUS[status] !== true;

function pruneEvents(events: readonly AgentRunEvent[]): AgentRunEvent[] {
  if (events.length <= MAX_EVENTS_PER_RUN) return [...events];
  const safety = events.filter((event) => CRITICAL_EVENT[event.type]).slice(-MAX_EVENTS_PER_RUN);
  if (safety.length >= MAX_EVENTS_PER_RUN) return safety;
  const ids = new Set(safety.map((event) => event.eventId));
  const diagnostics = events.filter((event) => !ids.has(event.eventId))
    .slice(-(MAX_EVENTS_PER_RUN - safety.length));
  return [...safety, ...diagnostics].sort((a, b) => a.sequence - b.sequence);
}

function retainedRuns(sidecar: AgentRuntimeSidecar): AgentRunRecord[] {
  const pending = new Set(sidecar.approvals.filter((item) => item.status === 'pending').map((item) => item.runId));
  const protectedRuns = sidecar.runs.filter((run) => !terminal(run.status) || pending.has(run.runId));
  const protectedIds = new Set(protectedRuns.map((run) => run.runId));
  const history = sidecar.runs.filter((run) => !protectedIds.has(run.runId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_AGENT_RUNS);
  return [...protectedRuns, ...history].map((run) => ({ ...run, events: pruneEvents(run.events) }));
}

function retainedApprovals(approvals: readonly AgentApprovalRecord[]): AgentApprovalRecord[] {
  const pending = approvals.filter((item) => item.status === 'pending');
  const pendingIds = new Set(pending.map((item) => item.approvalId));
  return [...pending, ...approvals.filter((item) => !pendingIds.has(item.approvalId))
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, MAX_APPROVALS)];
}

function retainedCheckpoints(
  sidecar: AgentRuntimeSidecar,
  runs: readonly AgentRunRecord[],
): AgentCheckpointRecord[] {
  const active = new Set(runs.filter((run) => !terminal(run.status)).map((run) => run.runId));
  const protectedRows = sidecar.checkpoints.filter((item) => active.has(item.runId));
  const protectedIds = new Set(protectedRows.map((item) => item.checkpointId));
  const runIds = new Set(runs.map((run) => run.runId));
  return [...protectedRows, ...sidecar.checkpoints
    .filter((item) => !protectedIds.has(item.checkpointId) && runIds.has(item.runId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_CHECKPOINTS)];
}

export function applyAgentRuntimeRetention(sidecar: AgentRuntimeSidecar): AgentRuntimeSidecar {
  const runs = retainedRuns(sidecar);
  const approvals = retainedApprovals(sidecar.approvals);
  const checkpoints = retainedCheckpoints(sidecar, runs);
  const reachable = new Set(checkpoints.map((item) => item.sourceArtifactId));
  for (const run of runs) for (const id of run.artifactIds) reachable.add(id);
  const artifacts = sidecar.artifacts.filter((item) => reachable.has(item.artifactId));
  return { ...sidecar, runs, approvals, checkpoints, artifacts };
}
