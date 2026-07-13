import type { TimelineState } from '../editor/types';

// IndexedDB-backed multi-project store (local-first stand-in for the source's
// Rocicorp Zero + IndexedDB). One store holds a `projects` index (metadata for
// the dashboard) plus one `project:<id>` entry per timeline. No dependency.
const DB_NAME = 'chatcut-clone';
const STORE = 'kv';
const INDEX_KEY = 'projects';
const projectKey = (id: string) => `project:${id}`;

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Validate at the boundary — persisted data is untrusted (stale / corrupt / other tab).
function isTimelineState(v: unknown): v is TimelineState {
  return !!v && typeof v === 'object'
    && Array.isArray((v as { items?: unknown }).items)
    && typeof (v as { fps?: unknown }).fps === 'number';
}

async function readIndex(): Promise<ProjectMeta[]> {
  const raw = await idbGet<unknown>(INDEX_KEY);
  return Array.isArray(raw) ? (raw as ProjectMeta[]).filter((m) => m && typeof m.id === 'string') : [];
}

/** Projects for the dashboard, newest-edited first. */
export async function listProjects(): Promise<ProjectMeta[]> {
  try {
    return (await readIndex()).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadProject(id: string): Promise<TimelineState | null> {
  try {
    const v = await idbGet<unknown>(projectKey(id));
    return isTimelineState(v) ? v : null;
  } catch {
    return null;
  }
}

/** Save a project's timeline and bump its index entry's updatedAt. */
export async function saveProject(id: string, state: TimelineState): Promise<void> {
  try {
    await idbSet(projectKey(id), state);
    const index = await readIndex();
    const entry = index.find((m) => m.id === id);
    if (entry) {
      await idbSet(INDEX_KEY, index.map((m) => (m.id === id ? { ...m, updatedAt: now() } : m)));
    }
  } catch {
    /* ignore persist failures; the session still works in-memory */
  }
}

export async function createProject(name: string, state: TimelineState): Promise<ProjectMeta> {
  const meta: ProjectMeta = { id: newId(), name, updatedAt: now() };
  await idbSet(projectKey(meta.id), state);
  await idbSet(INDEX_KEY, [meta, ...(await readIndex())]);
  return meta;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const index = await readIndex();
  await idbSet(INDEX_KEY, index.map((m) => (m.id === id ? { ...m, name, updatedAt: now() } : m)));
}

export async function duplicateProject(id: string): Promise<ProjectMeta | null> {
  const state = await loadProject(id);
  if (!state) return null;
  const src = (await readIndex()).find((m) => m.id === id);
  return createProject(`${src?.name ?? '工程'} 副本`, state);
}

export async function deleteProject(id: string): Promise<void> {
  await idbDel(projectKey(id));
  await idbSet(INDEX_KEY, (await readIndex()).filter((m) => m.id !== id));
}

const now = () => Date.now();
const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `p_${now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

// Auto-name for new empty projects (source does the same, e.g. "Colourful Ivory Galliform").
const ADJ = ['流光', '静默', '暖阳', '深蓝', '轻盈', '锋利', '柔和', '斑斓', '清冽', '灼热', '朦胧', '澄澈'];
const NOUN = ['序曲', '航迹', '棱镜', '潮汐', '织机', '回响', '飞羽', '砂丘', '苔原', '穹顶', '流域', '星图'];
export function randomProjectName(): string {
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJ)}${pick(NOUN)}`;
}
