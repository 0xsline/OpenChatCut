import type { ExportDestination } from './exportDestination';
import {
  browserDestination,
  hasServerExportDestinationAuthority,
  readLocalRecord,
  readLocalRecords,
  remoteSafeRecord,
  removeLocalRecord,
  resetServerExportRecoveryMemory,
  validRecord,
  writeLocalRecord,
} from './serverExportRecoveryStore';
import type {
  PersistedServerExportJob,
  ServerExportDeliveryClaim,
  ServerExportRecoveryDestination,
  ServerExportRecoveryStage,
} from './serverExportRecoveryStore';
import {
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
} from '../persist/projectStoreTransport';

export {
  hasServerExportDestinationAuthority,
  resetServerExportRecoveryMemory,
};
export type {
  PersistedServerExportJob,
  ServerExportDeliveryClaim,
  ServerExportRecoveryDestination,
  ServerExportRecoveryStage,
};

/** Server-side kv prefix (phase B: recovery state survives cache wipes). */
const REMOTE_PREFIX = 'export-recovery:';
const DELIVERY_LEASE_MS = 120_000;
const deliveryOwnerId = globalThis.crypto?.randomUUID?.()
  ?? `export-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`;


class RetiredExportRecoveryError extends Error {}

function joinRemoteRecord(
  remote: PersistedServerExportJob,
  local?: PersistedServerExportJob | null,
): PersistedServerExportJob {
  const destination = browserDestination(remote.destination)
    && local && browserDestination(local.destination)
    && local.destination.type === remote.destination.type
    && hasServerExportDestinationAuthority(local.destination)
    ? local.destination
    : remote.destination;
  return { ...remote, destination, remoteAuthorityEstablished: true };
}

async function reconcileRemoteRecord(
  record: PersistedServerExportJob,
): Promise<PersistedServerExportJob | null> {
  const result = leaseResponse(await requestProjectStore({
    operation: 'export-recovery-lease',
    key: `${REMOTE_PREFIX}${record.renderId}`,
    renderId: record.renderId,
    action: 'reconcile',
    ownerInstanceId: deliveryOwnerId,
    authorityEstablished: record.remoteAuthorityEstablished === true,
    value: remoteSafeRecord(record),
  }));
  return result.accepted && validRecord(result.value) ? result.value : null;
}

export async function persistServerExportJob(record: PersistedServerExportJob): Promise<void> {
  const requiresLocalAuthority = browserDestination(record.destination);
  let localSaved = false;
  let localError: unknown;
  if (requiresLocalAuthority) {
    try {
      await writeLocalRecord(record);
      localSaved = true;
    } catch (error) {
      localError = error;
    }
  }
  let remoteSaved = false;
  if (projectStoreWriteCredential()) {
    try {
      const canonical = await reconcileRemoteRecord(record);
      if (!canonical) throw new RetiredExportRecoveryError('导出恢复记录已退役');
      remoteSaved = true;
      if (localSaved) await writeLocalRecord(joinRemoteRecord(canonical, record));
    } catch (error) {
      if (error instanceof RetiredExportRecoveryError) {
        if (localSaved) await removeLocalRecord(record.renderId);
        throw error;
      }
    }
  }
  if (!localSaved && !remoteSaved) {
    await writeLocalRecord(record);
    localSaved = true;
  }
  if (requiresLocalAuthority && !localSaved) {
    throw localError instanceof Error ? localError : new Error('无法保存浏览器导出目标授权');
  }
}

type RecoveryTransitionAction = 'ready' | 'ambiguous' | 'commit';

async function updateLocalStage(
  renderId: string,
  stage: ServerExportRecoveryStage,
  claim?: ServerExportDeliveryClaim,
): Promise<boolean> {
  const local = await readLocalRecord(renderId);
  if (!local) return false;
  if (stage === 'output-ready' && local.stage !== 'polling') return true;
  if (stage !== 'output-ready') {
    const active = local.deliveryClaim;
    if (!claim || active?.leaseToken !== claim.leaseToken || active.leaseExpiresAt <= Date.now()) return false;
  }
  await writeLocalRecord({ ...local, stage, updatedAt: Date.now() });
  return true;
}

async function transitionServerExportStage(
  renderId: string,
  action: RecoveryTransitionAction,
  stage: ServerExportRecoveryStage,
  claim?: ServerExportDeliveryClaim,
): Promise<void> {
  if (projectStoreRemoteAvailable()) {
    const result = leaseResponse(await requestProjectStore({
      operation: 'export-recovery-lease',
      key: `${REMOTE_PREFIX}${renderId}`,
      renderId,
      action,
      ownerInstanceId: deliveryOwnerId,
      ...(claim ? { leaseToken: claim.leaseToken } : {}),
    }));
    if (!result.accepted) throw new Error('导出恢复阶段已变更');
    const local = await readLocalRecord(renderId);
    if (local && validRecord(result.value)) {
      await writeLocalRecord(joinRemoteRecord(result.value, local));
    }
    return;
  }
  if (!await updateLocalStage(renderId, stage, claim)) throw new Error('无法持久化导出恢复阶段');
}

export const markServerExportOutputReady = (
  renderId: string,
  claim?: ServerExportDeliveryClaim,
) => transitionServerExportStage(renderId, 'ready', 'output-ready', claim);

export const markServerExportDeliveryAmbiguous = (
  renderId: string,
  claim: ServerExportDeliveryClaim,
) => transitionServerExportStage(renderId, 'ambiguous', 'delivery-ambiguous', claim);

export const markServerExportTargetCommitted = (
  renderId: string,
  claim: ServerExportDeliveryClaim,
) => transitionServerExportStage(renderId, 'commit', 'target-committed', claim);


function leaseResponse(value: unknown): {
  accepted: boolean;
  lease?: ServerExportDeliveryClaim;
  value?: unknown;
} {
  return value as { accepted: boolean; lease?: ServerExportDeliveryClaim; value?: unknown };
}

async function localDeliveryLease(
  renderId: string,
  action: 'claim' | 'renew' | 'release' | 'check',
  claim?: ServerExportDeliveryClaim,
): Promise<ServerExportDeliveryClaim | null> {
  const record = await readLocalRecord(renderId);
  if (!record) return null;
  const recoverable = record.stage === 'polling' || record.stage === 'output-ready'
    || record.stage === 'delivery-ambiguous';
  if (action !== 'release' && !recoverable) return null;
  const current = record.deliveryClaim;
  const now = Date.now();
  const exact = current?.ownerInstanceId === deliveryOwnerId
    && !!claim && current.leaseToken === claim.leaseToken;
  if (action === 'check') return exact && current!.leaseExpiresAt > now ? current! : null;
  if (action === 'renew') {
    if (!exact || current!.leaseExpiresAt <= now) return null;
    const renewed = { ...current!, leaseExpiresAt: now + DELIVERY_LEASE_MS };
    await writeLocalRecord({ ...record, deliveryClaim: renewed, updatedAt: now });
    return renewed;
  }
  if (action === 'release') {
    if (!exact) return null;
    const { deliveryClaim: _deliveryClaim, ...released } = record;
    await writeLocalRecord({ ...released, updatedAt: now });
    return current!;
  }
  if (current && current.leaseExpiresAt > now && !exact) return null;
  const acquired = {
    ownerInstanceId: deliveryOwnerId,
    leaseToken: exact ? current!.leaseToken : (globalThis.crypto?.randomUUID?.()
      ?? `delivery-${now}-${Math.random().toString(36).slice(2)}`),
    leaseExpiresAt: now + DELIVERY_LEASE_MS,
  };
  await writeLocalRecord({ ...record, deliveryClaim: acquired, updatedAt: now });
  return acquired;
}

async function updateRemoteDeliveryLease(
  renderId: string,
  action: 'claim' | 'renew' | 'release' | 'check',
  claim?: ServerExportDeliveryClaim,
): Promise<ServerExportDeliveryClaim | null> {
  const response = leaseResponse(await requestProjectStore({
    operation: 'export-recovery-lease',
    key: `${REMOTE_PREFIX}${renderId}`,
    renderId,
    action,
    ownerInstanceId: deliveryOwnerId,
    ...(claim ? { leaseToken: claim.leaseToken } : {}),
    ...(action === 'claim' || action === 'renew' ? { leaseMs: DELIVERY_LEASE_MS } : {}),
  }));
  return response.accepted && response.lease ? response.lease : null;
}

export async function claimServerExportDelivery(
  renderId: string,
): Promise<ServerExportDeliveryClaim | null> {
  return projectStoreRemoteAvailable()
    ? updateRemoteDeliveryLease(renderId, 'claim')
    : localDeliveryLease(renderId, 'claim');
}

export async function renewServerExportDelivery(
  renderId: string,
  claim: ServerExportDeliveryClaim,
): Promise<ServerExportDeliveryClaim | null> {
  return projectStoreRemoteAvailable()
    ? updateRemoteDeliveryLease(renderId, 'renew', claim)
    : localDeliveryLease(renderId, 'renew', claim);
}

export async function checkServerExportDelivery(
  renderId: string,
  claim: ServerExportDeliveryClaim,
): Promise<boolean> {
  const active = projectStoreRemoteAvailable()
    ? await updateRemoteDeliveryLease(renderId, 'check', claim)
    : await localDeliveryLease(renderId, 'check', claim);
  return active !== null;
}

export async function releaseServerExportDelivery(
  renderId: string,
  claim: ServerExportDeliveryClaim,
): Promise<void> {
  if (projectStoreRemoteAvailable()) {
    await updateRemoteDeliveryLease(renderId, 'release', claim);
  } else {
    await localDeliveryLease(renderId, 'release', claim);
  }
}

async function recoveryRecordById(renderId: string): Promise<PersistedServerExportJob | null> {
  if (projectStoreRemoteAvailable()) {
    const response = await requestProjectStore({ operation: 'entry', key: `${REMOTE_PREFIX}${renderId}` });
    const row = response as { found: boolean; value?: unknown };
    if (!row.found || !validRecord(row.value)) return null;
    return joinRemoteRecord(row.value, await readLocalRecord(renderId));
  }
  return readLocalRecord(renderId);
}

export async function rebindServerExportJob(
  renderId: string,
  destination: ExportDestination,
  targetPath: string,
  claim: ServerExportDeliveryClaim,
): Promise<PersistedServerExportJob> {
  if (!await checkServerExportDelivery(renderId, claim)) throw new Error('导出恢复目标绑定已失效');
  const current = await recoveryRecordById(renderId);
  if (!current || (current.stage !== 'polling' && current.stage !== 'output-ready'
    && current.stage !== 'delivery-ambiguous')) {
    throw new Error('保留的导出结果已不可恢复');
  }
  const next: PersistedServerExportJob = {
    ...current,
    destination,
    targetPath,
    stage: current.stage === 'delivery-ambiguous' ? 'output-ready' : current.stage,
    deliveryClaim: claim,
    updatedAt: Date.now(),
  };
  if (projectStoreRemoteAvailable()) {
    const result = leaseResponse(await requestProjectStore({
      operation: 'export-recovery-lease',
      key: `${REMOTE_PREFIX}${renderId}`,
      renderId,
      action: 'rebind',
      ownerInstanceId: deliveryOwnerId,
      leaseToken: claim.leaseToken,
      value: remoteSafeRecord(next),
    }));
    if (!result.accepted || !validRecord(result.value)) {
      throw new Error('导出恢复目标绑定已失效');
    }
    const canonical = joinRemoteRecord(result.value, next);
    if (browserDestination(destination) || await readLocalRecord(renderId)) {
      await writeLocalRecord(canonical);
    }
    if (!await checkServerExportDelivery(renderId, claim)) throw new Error('导出恢复目标绑定已失效');
    return canonical;
  }
  await writeLocalRecord(next);
  if (!await checkServerExportDelivery(renderId, claim)) throw new Error('导出恢复目标绑定已失效');
  return next;
}

export async function retireServerExportJob(renderId: string): Promise<boolean> {
  if (!projectStoreRemoteAvailable()) {
    const local = await readLocalRecord(renderId);
    if (!local) return true;
    if (local.deliveryClaim && local.deliveryClaim.leaseExpiresAt > Date.now()) return false;
    await removeLocalRecord(renderId);
    return true;
  }
  const result = leaseResponse(await requestProjectStore({
    operation: 'export-recovery-lease',
    key: `${REMOTE_PREFIX}${renderId}`,
    renderId,
    action: 'retire',
    ownerInstanceId: deliveryOwnerId,
  }));
  if (!result.accepted) return false;
  await removeLocalRecord(renderId);
  return true;
}

interface RemoteRecoverySnapshot {
  active: Map<string, PersistedServerExportJob>;
  known: Set<string>;
  reachable: boolean;
}

function legacyDeletePending(record: PersistedServerExportJob): boolean {
  return (record as PersistedServerExportJob & { pendingRemoteDelete?: true }).pendingRemoteDelete === true;
}

async function readRemoteRecoverySnapshot(): Promise<RemoteRecoverySnapshot> {
  if (!projectStoreRemoteAvailable()) return { active: new Map(), known: new Set(), reachable: false };
  try {
    const response = await requestProjectStore({ operation: 'snapshot' });
    const snapshot = response as { version: 1; entries: Record<string, unknown> };
    const active = new Map<string, PersistedServerExportJob>();
    const known = new Set<string>();
    for (const [key, value] of Object.entries(snapshot.entries)) {
      if (!key.startsWith(REMOTE_PREFIX)) continue;
      const renderId = key.slice(REMOTE_PREFIX.length);
      known.add(renderId);
      if (validRecord(value)) active.set(renderId, value);
    }
    return { active, known, reachable: true };
  } catch {
    return { active: new Map(), known: new Set(), reachable: false };
  }
}

async function joinedRemoteRecords(
  snapshot: RemoteRecoverySnapshot,
  localByRenderId: Map<string, PersistedServerExportJob>,
): Promise<PersistedServerExportJob[]> {
  const records: PersistedServerExportJob[] = [];
  for (const [renderId, remote] of snapshot.active) {
    const local = localByRenderId.get(renderId);
    if (local && legacyDeletePending(local)) {
      if (projectStoreWriteCredential()) await retireServerExportJob(renderId).catch(() => false);
      continue;
    }
    const joined = joinRemoteRecord(remote, local);
    records.push(joined);
    if (local) await writeLocalRecord(joined).catch(() => undefined);
  }
  return records;
}

async function reconciledLocalRecords(
  snapshot: RemoteRecoverySnapshot,
  localRecords: PersistedServerExportJob[],
): Promise<PersistedServerExportJob[]> {
  const records: PersistedServerExportJob[] = [];
  for (const local of localRecords) {
    if (snapshot.active.has(local.renderId)) continue;
    if (snapshot.known.has(local.renderId)) {
      await removeLocalRecord(local.renderId).catch(() => undefined);
      continue;
    }
    if (!snapshot.reachable) {
      records.push(local);
      continue;
    }
    if (legacyDeletePending(local) || (!projectStoreWriteCredential() && local.remoteAuthorityEstablished)) {
      await removeLocalRecord(local.renderId).catch(() => undefined);
      continue;
    }
    if (!projectStoreWriteCredential()) {
      records.push(local);
      continue;
    }
    try {
      const canonical = await reconcileRemoteRecord(local);
      if (!canonical) {
        await removeLocalRecord(local.renderId);
        continue;
      }
      const joined = joinRemoteRecord(canonical, local);
      await writeLocalRecord(joined);
      records.push(joined);
    } catch {
      records.push(local);
    }
  }
  return records;
}

export async function listServerExportJobs(projectId: string): Promise<PersistedServerExportJob[]> {
  const snapshot = await readRemoteRecoverySnapshot();
  const localRecords = await readLocalRecords();
  const localByRenderId = new Map(localRecords.map((record) => [record.renderId, record]));
  const records = [
    ...await joinedRemoteRecords(snapshot, localByRenderId),
    ...await reconciledLocalRecords(snapshot, localRecords),
  ];
  return records
    .filter((record) => record.projectId === projectId)
    .sort((left, right) => left.createdAt - right.createdAt);
}
