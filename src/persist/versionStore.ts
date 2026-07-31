// Version history (/api/versions): List of named snapshots saved by project, reused during recovery
// migrateProjectDoc verification. Share native server KV with projectStore.
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
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
function toValidVersion(v: unknown): { version: ProjectVersion; migrated: boolean } | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<ProjectVersion>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.createdAt !== 'number') return null;
  let migrated = false;
  const doc = migrateProjectDoc(raw.doc, { onProgress: () => { migrated = true; } });
  if (!doc) return null;
  return {
    version: {
      id: raw.id,
      name: raw.name,
      createdAt: raw.createdAt,
      automatic: raw.automatic === true,
      doc,
    },
    migrated,
  };
}

async function readAll(projectId: string): Promise<ProjectVersion[]> {
  const raw = await idbGet<unknown>(versionsKey(projectId));
  if (!Array.isArray(raw)) return [];
  const parsed = raw.map(toValidVersion);
  const valid = parsed.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const versions = valid.map((entry) => entry.version);
  if (valid.length === raw.length && valid.some((entry) => entry.migrated)) {
    try {
      await idbSet(versionsKey(projectId), versions);
    } catch {
      // Retry persistence the next time snapshots are read.
    }
  }
  return versions;
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
  const current = await readAll(projectId);
  const next = [version, ...current];
  const retainedAutomaticIds = new Set(
    next.filter((item) => item.automatic).slice(0, MAX_AUTOMATIC_VERSIONS).map((item) => item.id),
  );
  await idbSet(
    versionsKey(projectId),
    next.filter((item) => !item.automatic || retainedAutomaticIds.has(item.id)),
  );
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
    const current = await readAll(projectId);
    await idbSet(versionsKey(projectId), current.filter((v) => v.id !== id));
  });
}
