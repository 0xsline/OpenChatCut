import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyAgentRuntimeStoreValue,
  isAgentArtifactStoreValue,
  isProjectStoreRecord,
  projectIdFromProjectStoreKey,
} from '../../shared/project-store-validation.ts';


interface ProjectMeta {
  id: string;
  updatedAt: number;
}

const MAX_RUNS = 30;
const MAX_EVENTS = 192;
const MAX_APPROVALS = 100;
const MAX_CHECKPOINTS = 8;
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const TERMINAL_RUNS: Record<string, true> = {
  completed: true, failed: true, aborted: true, interrupted: true,
};
const isTerminalRun = (status: unknown): boolean =>
  typeof status === 'string' && TERMINAL_RUNS[status] === true;

function validSidecarRows(sidecar: Record<string, unknown>, projectId: string): boolean {
  const groups: Array<[unknown, string]> = [
    [sidecar.runs, 'runId'], [sidecar.approvals, 'approvalId'],
    [sidecar.checkpoints, 'checkpointId'], [sidecar.artifacts, 'artifactId'],
  ];
  return groups.every(([rows, id]) => Array.isArray(rows) && rows.every((row) =>
    isProjectStoreRecord(row) && row.projectId === projectId
    && typeof row[id] === 'string' && row[id].length > 0));
}

function hasStructuralRuns(sidecar: Record<string, unknown>): boolean {
  return (sidecar.runs as unknown[]).every((row) =>
    isProjectStoreRecord(row)
    && Array.isArray(row.events)
    && Array.isArray(row.artifactIds)
    && Array.isArray(row.checkpointIds)
    && Array.isArray(row.proposalIds));
}

function mergeRows(
  base: unknown[],
  incoming: unknown[],
  id: string,
  combine?: (left: Record<string, unknown>, right: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const item of [...base, ...incoming]) {
    if (!isProjectStoreRecord(item) || typeof item[id] !== 'string') continue;
    const previous = merged.get(item[id]);
    if (!previous) merged.set(item[id], item);
    else merged.set(item[id], combine ? combine(previous, item)
      : itemTime(item) >= itemTime(previous) ? item : previous);
  }
  return [...merged.values()];
}

function preferredRun(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  if (isTerminalRun(left.status)) return left;
  if (left.leaseToken) {
    const exactLease = left.ownerInstanceId === right.ownerInstanceId
      && left.leaseToken === right.leaseToken;
    if (!exactLease) return left;
  }
  if (isTerminalRun(right.status)) return right;
  return itemTime(right) >= itemTime(left) ? right : left;
}

function mergeRun(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const newer = preferredRun(left, right);
  const older = newer === right ? left : right;
  const mergeIds = (key: string): string[] => [...new Set([
    ...(Array.isArray(left[key]) ? left[key] : []),
    ...(Array.isArray(right[key]) ? right[key] : []),
  ].filter((id): id is string => typeof id === 'string'))];
  const events = mergeRows(
    Array.isArray(left.events) ? left.events : [],
    Array.isArray(right.events) ? right.events : [],
    'eventId',
  ).sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0)).slice(-MAX_EVENTS);
  const legacyRenewal = !left.leaseToken && !right.leaseToken
    && !!left.ownerInstanceId && left.ownerInstanceId === right.ownerInstanceId;
  const leaseSource = legacyRenewal ? newer : left;
  return {
    ...older, ...newer, events,
    artifactIds: mergeIds('artifactIds'),
    checkpointIds: mergeIds('checkpointIds'),
    proposalIds: mergeIds('proposalIds'),
    ownerInstanceId: leaseSource.ownerInstanceId,
    leaseToken: leaseSource.leaseToken,
    leaseExpiresAt: leaseSource.leaseExpiresAt,
  };
}

function retainRuntimeRows(sidecar: Record<string, unknown>): Record<string, unknown> {
  const approvals = sidecar.approvals as Record<string, unknown>[];
  const pending = approvals.filter((row) => row.status === 'pending');
  const settled = approvals.filter((row) => row.status !== 'pending')
    .sort((a, b) => itemTime(b) - itemTime(a)).slice(0, MAX_APPROVALS);
  const pendingRuns = new Set(pending.map((row) => row.runId));
  const runs = sidecar.runs as Record<string, unknown>[];
  const protectedRuns = runs.filter((row) => !isTerminalRun(row.status) || pendingRuns.has(row.runId));
  const protectedIds = new Set(protectedRuns.map((row) => row.runId));
  const retainedRuns = [...protectedRuns, ...runs.filter((row) => !protectedIds.has(row.runId))
    .sort((a, b) => itemTime(b) - itemTime(a)).slice(0, MAX_RUNS)];
  const retainedRunIds = new Set(retainedRuns.map((row) => row.runId));
  const activeRuns = new Set(retainedRuns.filter((row) => !isTerminalRun(row.status)).map((row) => row.runId));
  const checkpoints = sidecar.checkpoints as Record<string, unknown>[];
  const protectedCheckpoints = checkpoints.filter((row) => activeRuns.has(row.runId));
  const checkpointIds = new Set(protectedCheckpoints.map((row) => row.checkpointId));
  const retainedCheckpoints = [...protectedCheckpoints, ...checkpoints
    .filter((row) => !checkpointIds.has(row.checkpointId) && retainedRunIds.has(row.runId))
    .sort((a, b) => itemTime(b) - itemTime(a)).slice(0, MAX_CHECKPOINTS)];
  return { ...sidecar, runs: retainedRuns, approvals: [...pending, ...settled], checkpoints: retainedCheckpoints };
}

function retainArtifactRows(sidecar: Record<string, unknown>): Record<string, unknown> {
  const runs = sidecar.runs as Record<string, unknown>[];
  const checkpoints = sidecar.checkpoints as Record<string, unknown>[];
  const reachable = new Set(checkpoints.map((row) => row.sourceArtifactId));
  for (const run of runs) for (const id of Array.isArray(run.artifactIds) ? run.artifactIds : []) reachable.add(id);
  const artifacts = (sidecar.artifacts as Record<string, unknown>[]).filter((row) => reachable.has(row.artifactId))
    .sort((a, b) => itemTime(b) - itemTime(a));
  const retained: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of artifacts) {
    const size = typeof row.originalBytes === 'number' && Number.isFinite(row.originalBytes) ? row.originalBytes : 0;
    if (retained.length >= MAX_ARTIFACTS || bytes + size > MAX_ARTIFACT_BYTES) continue;
    retained.push(row); bytes += size;
  }
  const artifactIds = new Set(retained.map((row) => row.artifactId));
  const keptCheckpoints = checkpoints.filter((row) => artifactIds.has(row.sourceArtifactId));
  const checkpointIds = new Set(keptCheckpoints.map((row) => row.checkpointId));
  const keptRuns = runs.map((run) => ({
    ...run,
    artifactIds: (Array.isArray(run.artifactIds) ? run.artifactIds : []).filter((id) => artifactIds.has(id)),
    checkpointIds: (Array.isArray(run.checkpointIds) ? run.checkpointIds : []).filter((id) => checkpointIds.has(id)),
  }));
  return { ...sidecar, runs: keptRuns, checkpoints: keptCheckpoints, artifacts: retained };
}

function mergeRuntimeSidecars(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const incomingNewer = Number(incoming.revision) > Number(base.revision)
    || (incoming.revision === base.revision && Number(incoming.updatedAt) > Number(base.updatedAt));
  const newer = incomingNewer ? incoming : base;
  const older = incomingNewer ? base : incoming;
  const merged = {
    ...older, ...newer,
    revision: Math.max(base.revision as number, incoming.revision as number),
    updatedAt: Math.max(base.updatedAt as number, incoming.updatedAt as number),
    runs: mergeRows(base.runs as unknown[], incoming.runs as unknown[], 'runId', mergeRun),
    approvals: mergeRows(base.approvals as unknown[], incoming.approvals as unknown[], 'approvalId'),
    checkpoints: mergeRows(base.checkpoints as unknown[], incoming.checkpoints as unknown[], 'checkpointId'),
    artifacts: mergeRows(base.artifacts as unknown[], incoming.artifacts as unknown[], 'artifactId'),
  };
  return retainArtifactRows(retainRuntimeRows(merged));
}

export function mergeAgentSidecar(
  key: string,
  base: unknown,
  incoming: unknown,
  hasBase: boolean,
): { accepted: boolean; value: unknown } {
  if (key.startsWith('agent-artifact:')) {
    if (hasBase) return { accepted: true, value: base };
    return { accepted: isAgentArtifactStoreValue(key, incoming), value: incoming };
  }
  const incomingCompatibility = classifyAgentRuntimeStoreValue(key, incoming);
  if (!hasBase) {
    return incomingCompatibility.kind === 'supported' || incomingCompatibility.kind === 'future'
      ? { accepted: true, value: incoming }
      : { accepted: false, value: incoming };
  }
  const baseCompatibility = classifyAgentRuntimeStoreValue(key, base);
  if (baseCompatibility.kind === 'future' || baseCompatibility.kind === 'corrupt') {
    return { accepted: true, value: base };
  }
  if (incomingCompatibility.kind === 'future') return { accepted: true, value: incoming };
  if (incomingCompatibility.kind !== 'supported' || baseCompatibility.kind !== 'supported') {
    return { accepted: true, value: base };
  }
  const baseSidecar = baseCompatibility.value;
  const incomingSidecar = incomingCompatibility.value;
  const projectId = projectIdFromProjectStoreKey(key);
  if (!projectId
    || !validSidecarRows(baseSidecar, projectId)
    || !validSidecarRows(incomingSidecar, projectId)) {
    return { accepted: true, value: base };
  }
  if (!isProjectStoreRecord(base) || !isProjectStoreRecord(incoming)) {
    return { accepted: true, value: base };
  }
  if (!hasStructuralRuns(baseSidecar) || !hasStructuralRuns(incomingSidecar)) {
    const revisionDelta = Number(incomingSidecar.revision) - Number(baseSidecar.revision);
    return {
      accepted: true,
      value: revisionDelta === 0
        ? Number(incomingSidecar.updatedAt) > Number(baseSidecar.updatedAt) ? incoming : base
        : revisionDelta > 0 ? incoming : base,
    };
  }
  return { accepted: true, value: mergeRuntimeSidecars(baseSidecar, incomingSidecar) };
}

function projectMetas(entries: Record<string, unknown>): Map<string, ProjectMeta> {
  const value = entries.projects;
  const metas = Array.isArray(value) ? value : [];
  return new Map(metas.flatMap((item) => {
    if (!isProjectStoreRecord(item) || typeof item.id !== 'string' || typeof item.updatedAt !== 'number') return [];
    return [[item.id, { id: item.id, updatedAt: item.updatedAt }]];
  }));
}

function itemIdentity(value: unknown): string {
  if (isProjectStoreRecord(value)) {
    for (const key of ['id', 'jobId', 'name']) {
      if (typeof value[key] === 'string') return `${key}:${value[key]}`;
    }
  }
  return `json:${JSON.stringify(value)}`;
}

function itemTime(value: unknown): number {
  if (!isProjectStoreRecord(value)) return 0;
  for (const key of ['updatedAt', 'createdAt']) {
    if (typeof value[key] === 'number') return value[key];
  }
  return 0;
}

function mergeArrays(base: unknown[], incoming: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  for (const item of [...base, ...incoming]) {
    const identity = itemIdentity(item);
    const previous = merged.get(identity);
    if (previous === undefined || itemTime(item) >= itemTime(previous)) merged.set(identity, item);
  }
  return [...merged.values()];
}

export function mergeProjectIndex(base: unknown, incoming: unknown): unknown[] {
  const left = Array.isArray(base) ? base : [];
  const right = Array.isArray(incoming) ? incoming : [];
  return mergeArrays(left, right).sort((a, b) => itemTime(b) - itemTime(a));
}

export function withoutDeletedProjects(
  entries: Record<string, unknown>,
  deletedIds: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key === 'projects') {
      result[key] = (Array.isArray(value) ? value : []).filter(
        (item) => !isProjectStoreRecord(item) || typeof item.id !== 'string' || !deletedIds.has(item.id),
      );
      continue;
    }
    const projectId = projectIdFromProjectStoreKey(key);
    if (!projectId || !deletedIds.has(projectId)) result[key] = value;
  }
  return result;
}

function shouldMergeArray(key: string, base: unknown, incoming: unknown): boolean {
  if (!Array.isArray(base) || !Array.isArray(incoming)) return false;
  return key === 'export:history'
    || key === 'design-styles:owned'
    || key === 'skills:custom'
    || key === 'templates:all'
    || key.startsWith('versions:')
    || key.startsWith('jobs:');
}

/** First-open migration merges every browser's unique projects without discarding either side. */
export function mergeProjectEntries(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  deletedIds: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const safeBase = withoutDeletedProjects(base, deletedIds);
  const safeIncoming = withoutDeletedProjects(incoming, deletedIds);
  const result = { ...safeBase };
  const baseMetas = projectMetas(safeBase);
  const incomingMetas = projectMetas(safeIncoming);
  for (const [key, value] of Object.entries(safeIncoming)) {
    if (key.startsWith('project-edit-ownership:')) continue;
    if (key.startsWith('project:')) {
      const ownedProjectId = projectIdFromProjectStoreKey(key);
      if (ownedProjectId && `project-edit-ownership:${ownedProjectId}` in safeBase) continue;
    }
    if (key === 'projects') {
      result[key] = mergeProjectIndex(safeBase[key], value);
      continue;
    }
    if (key.startsWith('agent-runtime:') || key.startsWith('agent-artifact:')) {
      const sidecar = mergeAgentSidecar(key, safeBase[key], value, key in safeBase);
      if (sidecar.accepted) result[key] = sidecar.value;
      continue;
    }
    if (!(key in safeBase)) {
      result[key] = value;
      continue;
    }
    if (shouldMergeArray(key, safeBase[key], value)) {
      result[key] = mergeArrays(safeBase[key] as unknown[], value as unknown[]);
      continue;
    }
    const projectId = projectIdFromProjectStoreKey(key);
    if (!projectId
      || (incomingMetas.get(projectId)?.updatedAt ?? 0) > (baseMetas.get(projectId)?.updatedAt ?? 0)) {
      result[key] = value;
    }
  }
  return result;
}

export async function purgeProjectEntryFiles(storeDir: string, projectId: string): Promise<void> {
  for (const file of await readdir(storeDir)) {
    if (!file.endsWith('.json')) continue;
    const key = decodeURIComponent(file.slice(0, -'.json'.length));
    if (projectIdFromProjectStoreKey(key) === projectId) {
      await rm(join(storeDir, file), { force: true });
    }
  }
}
