import { isProjectDocumentKey, sameStoredValue, storedJson } from './sharedKvPending';

export interface StoreSnapshot {
  version: 1;
  entries: Record<string, unknown>;
}
type Merge = (entries: Record<string, unknown>) => Promise<StoreSnapshot>;
type ReadEntry = (key: string) => Promise<{ found: boolean; value?: unknown }>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

async function recoveryId(key: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(storedJson([key, value]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `recovered_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function recoveryMeta(id: string, sourceId: string, index: unknown): Record<string, unknown> {
  const source: unknown = Array.isArray(index)
    ? index.find((entry: unknown) => isRecord(entry) && entry.id === sourceId)
    : undefined;
  const meta = isRecord(source) ? source : {};
  const { deletedAt: _deletedAt, ...retained } = meta;
  return { ...retained, id, name: `[Recovered offline] ${meta.name ?? sourceId}`, updatedAt: Date.now() };
}

async function preserveProject(
  key: string,
  value: unknown,
  local: Record<string, unknown>,
  snapshot: StoreSnapshot,
  merge: Merge,
  readEntry: ReadEntry,
): Promise<StoreSnapshot> {
  const baseId = await recoveryId(key, value);
  let id = baseId;
  for (let suffix = 1; ; suffix += 1) {
    // Index-only merge replies cannot tell whether an earlier recovery was edited.
    const candidate = await readEntry(`project:${id}`);
    if (!candidate.found || sameStoredValue(candidate.value, value)) break;
    id = `${baseId}_${suffix}`;
  }
  const meta = recoveryMeta(id, key.slice('project:'.length), local.projects);
  const next = await merge({ [`project:${id}`]: value, projects: [meta] });
  const indexed = Array.isArray(next.entries.projects)
    && next.entries.projects.some((entry: unknown) => isRecord(entry) && entry.id === id);
  if (!indexed || !sameStoredValue(next.entries[`project:${id}`], value)) {
    throw new Error('离线恢复副本尚未保存，原始离线修改仍保留在本机');
  }
  // Merge responses include only the index and keys explicitly read back.
  // Keep confirmations from earlier documents for this bootstrap's remaining keys.
  return { ...next, entries: { ...snapshot.entries, ...next.entries } };
}

/** Only unsynced documents enter this path; ordinary migration and saves are unchanged. */
export async function recoverUnmergedProjects(
  local: Record<string, unknown>,
  snapshot: StoreSnapshot,
  pending: ReadonlySet<string>,
  merge: Merge,
  readEntry: ReadEntry,
): Promise<{ snapshot: StoreSnapshot; recovered: Set<string> }> {
  const recovered = new Set<string>();
  let next = snapshot;
  for (const key of pending) {
    if (!isProjectDocumentKey(key) || !Object.hasOwn(local, key)
      || sameStoredValue(local[key], next.entries[key])) continue;
    next = await preserveProject(key, local[key], local, next, merge, readEntry);
    recovered.add(key);
  }
  return { snapshot: next, recovered };
}
