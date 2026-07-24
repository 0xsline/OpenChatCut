// Version history (/api/versions): List of named snapshots saved by project, reused during recovery
// migrateProjectDoc verification. Share native server KV with projectStore.
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
import type { ProjectDoc } from '../editor/types';

const versionsKey = (projectId: string) => `versions:${projectId}`;

export interface ProjectVersion {
  id: string;
  name: string;
  createdAt: number;
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
  return { version: { id: raw.id, name: raw.name, createdAt: raw.createdAt, doc }, migrated };
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

/** All snapshots of the project,Newest first. Any failure returns an empty array(Don’t trust persistent data)。 */
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

/** Save the current project document as a named snapshot(forward penetration,latest first)。 */
export async function saveVersion(projectId: string, name: string, doc: ProjectDoc): Promise<ProjectVersion> {
  const version: ProjectVersion = { id: newId(), name: name.trim() || 'unnamed version', createdAt: Date.now(), doc };
  const current = await readAll(projectId);
  await idbSet(versionsKey(projectId), [version, ...current]);
  return version;
}

export async function deleteVersion(projectId: string, id: string): Promise<void> {
  const current = await readAll(projectId);
  await idbSet(versionsKey(projectId), current.filter((v) => v.id !== id));
}
