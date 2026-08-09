import type { AgentRunLeaseState } from '../../shared/project-store-transport';
import { kvUpdateAgentRunLease } from './sharedKv';
import type { AgentRunRecord, AgentRuntimeSidecar } from './agentRuntimeStore';

const ACTIVE_STATUS: Record<string, true> = {
  running: true,
  waiting_approval: true,
  awaiting_user: true,
};

export interface AgentRunLeaseResult {
  authoritative: boolean;
  lease: AgentRunLeaseState | null;
}

export interface AgentRunLeaseReleaseResult {
  authoritative: boolean;
  accepted: boolean;
}

type RuntimeMutator = <T>(
  change: (current: AgentRuntimeSidecar) => [AgentRuntimeSidecar, T],
) => Promise<T>;

interface UpdateLeaseInput {
  projectId: string;
  runId: string;
  ownerInstanceId: string;
  leaseToken?: string;
  leaseExpiresAt: number;
  claim: boolean;
  now: number;
}

function localLease(
  input: UpdateLeaseInput,
  mutate: RuntimeMutator,
): Promise<AgentRunLeaseState | null> {
  return mutate((current) => {
    const run = current.runs.find((item) => item.runId === input.runId);
    const active = !!run && ACTIVE_STATUS[run.status] === true;
    const exact = run?.ownerInstanceId === input.ownerInstanceId
      && !!input.leaseToken
      && run.leaseToken === input.leaseToken;
    const available = input.claim && !!run && (
      !run.ownerInstanceId || !run.leaseExpiresAt || run.leaseExpiresAt <= input.now
      || exact || (run.ownerInstanceId === input.ownerInstanceId && !run.leaseToken)
    );
    if (!run || !active || (!exact && !available)) return [current, null];
    const lease = {
      ownerInstanceId: input.ownerInstanceId,
      leaseToken: exact ? input.leaseToken! : crypto.randomUUID(),
      leaseExpiresAt: input.leaseExpiresAt,
    };
    const runs = current.runs.map((item) => item.runId === input.runId
      ? { ...item, ...lease, updatedAt: input.now }
      : item);
    return [{ ...current, runs }, lease];
  });
}

export async function updateAgentRunLeaseAuthority(
  input: UpdateLeaseInput,
  mutate: RuntimeMutator,
): Promise<AgentRunLeaseResult> {
  const leaseMs = Math.round(input.leaseExpiresAt - input.now);
  if (!input.ownerInstanceId || leaseMs < 1_000 || leaseMs > 300_000) {
    return { authoritative: false, lease: null };
  }
  const canonical = await kvUpdateAgentRunLease({
    operation: 'agent-run-lease',
    key: `agent-runtime:${input.projectId}`,
    runId: input.runId,
    action: input.claim ? 'claim' : 'renew',
    ownerInstanceId: input.ownerInstanceId,
    ...(input.leaseToken ? { leaseToken: input.leaseToken } : {}),
    leaseMs,
  });
  if (canonical) {
    return {
      authoritative: true,
      lease: canonical.accepted && canonical.lease ? canonical.lease : null,
    };
  }
  return { authoritative: false, lease: await localLease(input, mutate) };
}

export async function releaseAgentRunLeaseAuthority(
  projectId: string,
  runId: string,
  ownerInstanceId: string,
  leaseToken: string,
  mutate: RuntimeMutator,
): Promise<AgentRunLeaseReleaseResult> {
  if (!ownerInstanceId || !leaseToken) return { authoritative: false, accepted: false };
  const canonical = await kvUpdateAgentRunLease({
    operation: 'agent-run-lease',
    key: `agent-runtime:${projectId}`,
    runId,
    action: 'release',
    ownerInstanceId,
    leaseToken,
  });
  if (canonical) return { authoritative: true, accepted: canonical.accepted };
  const accepted = await mutate((current) => {
    const run = current.runs.find((item) => item.runId === runId);
    if (!run || ACTIVE_STATUS[run.status] !== true
      || run.ownerInstanceId !== ownerInstanceId || run.leaseToken !== leaseToken) {
      return [current, false];
    }
    const runs = current.runs.map((item): AgentRunRecord => item.runId === runId
      ? { ...item, ownerInstanceId: undefined, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() }
      : item);
    return [{ ...current, runs }, true];
  });
  return { authoritative: false, accepted };
}
