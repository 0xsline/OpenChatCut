// Version history (/api/versions): List of named snapshots saved by project, reused during recovery
// migrateProjectDoc verification. Share native server KV with projectStore.
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
import { partitionRecords, withPreservedRecords } from './recordPartition';
import type { ProjectDoc } from '../editor/types';

const versionsKey = (projectId: string) => `versions:${projectId}`;
export const MAX_AUTOMATIC_VERSIONS = 30;
const mutationQueues = new Map<string, Promise<unknown>>();

export interface ProjectVersion {
  id: string;
  name: string;
  createdAt: number;
  automatic?: boolean;
  doc: ProjectDoc;
}

// Boundary verification: Persistent data is not trustworthy and should be verified before use (id/name/createdAt + doc is regulated by migrateProjectDoc).
function toValidVersion(v: unknown): ProjectVersion | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<ProjectVersion>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.createdAt !== 'number') return null;
  const doc = migrateProjectDoc(raw.doc);
  if (!doc) return null;
  return {
    // Unknown envelope fields pass through; only validated ones are replaced.
    ...raw,
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    automatic: raw.automatic === true,
    doc,
  };
}

/** Readable snapshots plus the entries this build cannot parse — a snapshot
 * written by a NEWER build reads as unparsable here, and the 30s automatic
 * save would otherwise erase it within minutes. */
async function readPartitioned(projectId: string) {
  return partitionRecords(await idbGet<unknown>(versionsKey(projectId)), toValidVersion);
}

async function readAll(projectId: string): Promise<ProjectVersion[]> {
  return (await readPartitioned(projectId)).valid;
}

/** All snapshots of the project, latest first. An empty array is returned on any failure (persistent data is not trusted).*/
export async function listVersions(projectId: string): Promise<ProjectVersion[]> {
  try {
    return (await readAll(projectId)).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `v_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

function sameDocument(left: ProjectDoc, right: ProjectDoc): boolean {
  const normalizedLeft = migrateProjectDoc(left);
  const normalizedRight = migrateProjectDoc(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}
function serializeMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(projectId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationQueues.set(projectId, current);
  return current.finally(() => {
    if (mutationQueues.get(projectId) === current) mutationQueues.delete(projectId);
  });
}

async function persistVersion(
  projectId: string,
  name: string,
  doc: ProjectDoc,
  automatic: boolean,
): Promise<ProjectVersion> {
  const version: ProjectVersion = {
    id: newId(),
    name: name.trim() || (automatic ? '自动保存' : '未命名版本'),
    createdAt: Date.now(),
    automatic,
    doc,
  };
  const { valid, opaque } = await readPartitioned(projectId);
  const next = [version, ...valid];
  const retainedAutomaticIds = new Set(
    next.filter((item) => item.automatic).slice(0, MAX_AUTOMATIC_VERSIONS).map((item) => item.id),
  );
  await idbSet(versionsKey(projectId), withPreservedRecords(
    next.filter((item) => !item.automatic || retainedAutomaticIds.has(item.id)),
    opaque,
  ));
  return version;
}

/** Save the current project document as a named snapshot (pre-insert, latest first).*/
export function saveVersion(projectId: string, name: string, doc: ProjectDoc): Promise<ProjectVersion> {
  return serializeMutation(projectId, () => persistVersion(projectId, name, doc, false));
}

/** Save a deduplicated automatic snapshot while preserving every manual version. */
export function saveAutomaticVersion(
  projectId: string,
  name: string,
  doc: ProjectDoc,
): Promise<ProjectVersion | null> {
  return serializeMutation(projectId, async () => {
    const latest = (await readAll(projectId)).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest && sameDocument(latest.doc, doc)) return null;
    return persistVersion(projectId, name, doc, true);
  });
}

export function deleteVersion(projectId: string, id: string): Promise<void> {
  return serializeMutation(projectId, async () => {
    const { valid, opaque } = await readPartitioned(projectId);
    await idbSet(versionsKey(projectId), withPreservedRecords(
      valid.filter((v) => v.id !== id),
      opaque,
    ));
  });
}
