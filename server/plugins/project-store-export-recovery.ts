import { randomUUID } from 'node:crypto';
import type {
  AgentRunLeaseState,
  ProjectStoreMutationResponse,
  ProjectStoreRequest,
} from '../../shared/project-store-transport.ts';
import type { LockedProjectStore } from './project-store.ts';

export type ExportRecoveryLeaseInput = Extract<
  ProjectStoreRequest,
  { operation: 'export-recovery-lease' }
>;
type WithStoreLock = <T>(work: (store: LockedProjectStore) => Promise<T>) => Promise<T>;
interface StoredEntry { found: boolean; value?: unknown }
export interface ExportRecoveryImmediateStore {
  readEntry(key: string): StoredEntry;
  writeEntry(key: string, value: unknown): void;
}
interface RecoveryMutation {
  next?: Record<string, unknown>;
  response: ProjectStoreMutationResponse;
}

function recoveryRecord(value: unknown, renderId: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.renderId !== renderId) return null;
  return record.stage === 'polling' || record.stage === 'output-ready'
    || record.stage === 'delivery-ambiguous' || record.stage === 'target-committed'
    ? record : null;
}

function retiredRecord(value: unknown, renderId: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.renderId === renderId && record.stage === 'retired'
    ? record : null;
}

export function isUnresolvedExportRecovery(value: unknown, renderId: string): boolean {
  const stage = recoveryRecord(value, renderId)?.stage;
  return stage === 'polling' || stage === 'output-ready' || stage === 'delivery-ambiguous';
}

function storedLease(record: Record<string, unknown>): AgentRunLeaseState | null {
  const claim = record.deliveryClaim;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null;
  const value = claim as Record<string, unknown>;
  return typeof value.ownerInstanceId === 'string'
    && typeof value.leaseToken === 'string'
    && typeof value.leaseExpiresAt === 'number'
    ? value as unknown as AgentRunLeaseState
    : null;
}

function exactLease(
  current: AgentRunLeaseState | null,
  input: ExportRecoveryLeaseInput,
  now: number,
): current is AgentRunLeaseState {
  return current?.ownerInstanceId === input.ownerInstanceId
    && !!input.leaseToken && current.leaseToken === input.leaseToken
    && current.leaseExpiresAt > now;
}

function response(
  stored: StoredEntry,
  accepted: boolean,
  lease?: AgentRunLeaseState,
): ProjectStoreMutationResponse {
  return {
    accepted,
    found: stored.found,
    ...(stored.value === undefined ? {} : { value: stored.value }),
    ...(lease ? { lease } : {}),
  };
}

function mutation(
  stored: StoredEntry,
  accepted: boolean,
  next?: Record<string, unknown>,
  lease?: AgentRunLeaseState,
): RecoveryMutation {
  const canonical = next ? { found: true, value: next } : stored;
  return { ...(next ? { next } : {}), response: response(canonical, accepted, lease) };
}

function reconcileMutation(
  stored: StoredEntry,
  input: ExportRecoveryLeaseInput,
  now: number,
): RecoveryMutation {
  const current = recoveryRecord(stored.value, input.renderId);
  const retired = retiredRecord(stored.value, input.renderId);
  const incoming = recoveryRecord(input.value, input.renderId);
  if (retired) return mutation(stored, true);
  if (current) {
    return mutation(stored, !!incoming && incoming.projectId === current.projectId);
  }
  if (stored.found) return mutation(stored, false);
  if (input.authorityEstablished) {
    return mutation(stored, true, { version: 1, renderId: input.renderId, stage: 'retired', updatedAt: now });
  }
  if (!incoming) return mutation(stored, false);
  const { deliveryClaim: _claim, ...unclaimed } = incoming;
  return mutation(stored, true, { ...unclaimed, updatedAt: now });
}

function rebindMutation(
  stored: StoredEntry,
  record: Record<string, unknown>,
  input: ExportRecoveryLeaseInput,
  now: number,
): RecoveryMutation {
  const current = storedLease(record);
  const incoming = recoveryRecord(input.value, input.renderId);
  const validStage = incoming?.stage === 'polling' || incoming?.stage === 'output-ready';
  if (!exactLease(current, input, now) || !incoming || !validStage
    || incoming.projectId !== record.projectId) return mutation(stored, false);
  return mutation(stored, true, {
    ...incoming,
    deliveryClaim: current,
    updatedAt: now,
  }, current);
}

function stageMutation(
  stored: StoredEntry,
  record: Record<string, unknown>,
  input: ExportRecoveryLeaseInput,
  now: number,
): RecoveryMutation {
  const current = storedLease(record);
  if (input.action === 'ready') {
    if (record.stage !== 'polling') return mutation(stored, true, undefined, current ?? undefined);
    return mutation(stored, true, { ...record, stage: 'output-ready', updatedAt: now }, current ?? undefined);
  }
  const exact = exactLease(current, input, now);
  const ambiguous = input.action === 'ambiguous' && record.stage === 'output-ready';
  const committed = input.action === 'commit'
    && (record.stage === 'output-ready' || record.stage === 'delivery-ambiguous');
  if (!exact || (!ambiguous && !committed)) return mutation(stored, false);
  const stage = input.action === 'ambiguous' ? 'delivery-ambiguous' : 'target-committed';
  return mutation(stored, true, { ...record, stage, updatedAt: now }, current);
}

function retireMutation(
  stored: StoredEntry,
  record: Record<string, unknown> | null,
  input: ExportRecoveryLeaseInput,
  now: number,
): RecoveryMutation {
  if (retiredRecord(stored.value, input.renderId)) return mutation(stored, true);
  if (stored.found && !record) return mutation(stored, false);
  const current = record ? storedLease(record) : null;
  if (current && current.leaseExpiresAt > now) return mutation(stored, false);
  const tombstone = {
    version: 1,
    renderId: input.renderId,
    ...(typeof record?.projectId === 'string' ? { projectId: record.projectId } : {}),
    stage: 'retired',
    updatedAt: now,
  };
  return mutation(stored, true, tombstone);
}

function acceptedLease(
  current: AgentRunLeaseState | null,
  input: ExportRecoveryLeaseInput,
  now: number,
): AgentRunLeaseState | null {
  const exact = current?.ownerInstanceId === input.ownerInstanceId
    && !!input.leaseToken && current.leaseToken === input.leaseToken;
  if (input.action === 'check') return exact && current!.leaseExpiresAt > now ? current : null;
  if (input.action === 'renew') {
    return exact && current!.leaseExpiresAt > now
      ? { ...current!, leaseExpiresAt: now + input.leaseMs! }
      : null;
  }
  if (input.action === 'release') return exact ? current : null;
  if (current && current.leaseExpiresAt > now && !exact) return null;
  return {
    ownerInstanceId: input.ownerInstanceId,
    leaseToken: exact ? current!.leaseToken : randomUUID(),
    leaseExpiresAt: now + input.leaseMs!,
  };
}

function leaseMutation(
  stored: StoredEntry,
  record: Record<string, unknown>,
  input: ExportRecoveryLeaseInput,
  now: number,
): RecoveryMutation {
  const releasableCommit = input.action === 'release' && record.stage === 'target-committed';
  if (!releasableCommit && record.stage !== 'polling' && record.stage !== 'output-ready'
    && record.stage !== 'delivery-ambiguous') return mutation(stored, false);
  const lease = acceptedLease(storedLease(record), input, now);
  if (!lease) return mutation(stored, false);
  if (input.action === 'check') return mutation(stored, true, undefined, lease);
  const { deliveryClaim: _claim, ...unclaimed } = record;
  const next = input.action === 'release'
    ? { ...unclaimed, updatedAt: now }
    : { ...record, deliveryClaim: lease, updatedAt: now };
  return mutation(stored, true, next, input.action === 'release' ? undefined : lease);
}

export function reduceExportRecoveryMutation(
  stored: StoredEntry,
  input: ExportRecoveryLeaseInput,
  now: number,
): RecoveryMutation {
  if (input.action === 'reconcile') return reconcileMutation(stored, input, now);
  const record = recoveryRecord(stored.value, input.renderId);
  if (input.action === 'retire') return retireMutation(stored, record, input, now);
  if (!record) return mutation(stored, false);
  if (input.action === 'rebind') return rebindMutation(stored, record, input, now);
  if (input.action === 'ready' || input.action === 'ambiguous' || input.action === 'commit') {
    return stageMutation(stored, record, input, now);
  }
  return leaseMutation(stored, record, input, now);
}

function requireLeaseDuration(input: ExportRecoveryLeaseInput): void {
  if ((input.action === 'claim' || input.action === 'renew') && input.leaseMs === undefined) {
    throw new Error('export recovery lease duration is required');
  }
}

export function executeImmediateExportRecoveryMutation(
  store: ExportRecoveryImmediateStore,
  input: ExportRecoveryLeaseInput,
  now = Date.now(),
): ProjectStoreMutationResponse {
  requireLeaseDuration(input);
  const mutation = reduceExportRecoveryMutation(store.readEntry(input.key), input, now);
  if (mutation.next) store.writeEntry(input.key, mutation.next);
  return mutation.response;
}

export function createExportRecoveryLeaseOperation(withStoreLock: WithStoreLock) {
  return async (input: ExportRecoveryLeaseInput): Promise<ProjectStoreMutationResponse> => {
    requireLeaseDuration(input);
    return withStoreLock(async (store) => {
      const stored = await store.readEntry(input.key);
      const result = reduceExportRecoveryMutation(stored, input, Date.now());
      if (result.next) await store.writeEntry(input.key, result.next);
      return result.response;
    });
  };
}
