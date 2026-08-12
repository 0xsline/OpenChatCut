import { randomUUID } from 'node:crypto';
import {
  mutate,
  type AgentRunEventType,
  type AgentRunStatus,
  type AgentRuntimeSidecar,
} from '../../src/persist/agentRuntimeStore';
import type { ProposalRuntimeStatus } from '../../src/agent/runtime-ledger';

export type { ProposalRuntimeStatus };

const TERMINAL = new Set<AgentRunStatus>(['completed', 'failed', 'aborted', 'interrupted']);

export type ServerRunSettleStatus = AgentRunStatus;

export interface ServerRunSettleInput {
  readonly status: ServerRunSettleStatus;
  readonly proposalId?: string;
  readonly proposalRuntimeStatus?: ProposalRuntimeStatus;
  readonly summary?: string;
}

export type ServerRunSettleOutcome = 'ok' | 'gone' | 'already';

function proposalEventType(status: ProposalRuntimeStatus): AgentRunEventType {
  switch (status) {
    case 'created': return 'proposal_created';
    case 'applied': return 'proposal_applied';
    case 'rejected': return 'proposal_rejected';
    case 'stale': return 'proposal_stale';
    case 'reproposed': return 'proposal_reproposed';
  }
}

function settleSidecar(
  projectId: string,
  runId: string,
  input: ServerRunSettleInput,
  current: AgentRuntimeSidecar,
): [AgentRuntimeSidecar, ServerRunSettleOutcome] {
  const run = current.runs.find((item) => item.runId === runId);
  if (!run) return [current, 'gone'];
  if (TERMINAL.has(run.status)) return [current, 'already'];
  const now = Date.now();
  const events = [...run.events];
  const pushEvent = (
    type: AgentRunEventType,
    extra: Partial<{ proposalId: string; summary: string }> = {},
  ): void => {
    events.push({
      eventId: randomUUID(),
      projectId,
      runId,
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      createdAt: now,
      type,
      ...extra,
    });
  };
  const proposalIds = input.proposalId
    ? [...new Set([...run.proposalIds, input.proposalId])]
    : run.proposalIds;
  if (input.proposalId && input.proposalRuntimeStatus) {
    pushEvent(proposalEventType(input.proposalRuntimeStatus), { proposalId: input.proposalId });
  }
  const finalSummary = input.summary?.trim() || undefined;
  const terminal = TERMINAL.has(input.status);
  const next: typeof run = {
    ...run,
    status: input.status,
    updatedAt: now,
    ...(finalSummary ? { finalSummary } : {}),
    ...(input.proposalId ? { proposalIds } : {}),
    ...(terminal
      ? { ownerInstanceId: undefined, leaseToken: undefined, leaseExpiresAt: undefined }
      : {}),
    events,
  };
  if (terminal) pushEvent('final', finalSummary ? { summary: finalSummary } : {});
  return [{ ...current, runs: current.runs.map((item) => item.runId === runId ? next : item) }, 'ok'];
}

/**
 * Server-side terminal settlement for a run whose editor no longer writes
 * the sidecar: the browser calls this once with the final status (and
 * optional proposal record) instead of resuming a recorder and writing
 * locally. Idempotent: a missing run reports 'gone' and an already
 * terminal run reports 'already'; neither is an error the UI should show.
 */
export async function settleServerRun(
  projectId: string,
  runId: string,
  input: ServerRunSettleInput,
): Promise<ServerRunSettleOutcome> {
  return mutate(projectId, (current) => settleSidecar(projectId, runId, input, current));
}
