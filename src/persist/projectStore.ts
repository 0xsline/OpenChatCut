import type { MediaAsset, ProjectDoc, Timeline, TimelineState } from '../editor/types';

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

type PersistedProjectShape = {
  version?: unknown;
  assets?: unknown;
  timelines: Timeline[];
  activeTimelineId: string;
};

function isProjectDocShape(v: unknown): v is PersistedProjectShape {
  return !!v && typeof v === 'object'
    && Array.isArray((v as { timelines?: unknown }).timelines)
    && (v as { timelines: unknown[] }).timelines.length > 0
    && (v as { timelines: unknown[] }).timelines.every(isTimelineState)
    && typeof (v as { activeTimelineId?: unknown }).activeTimelineId === 'string';
}

function isMediaAsset(v: unknown): v is MediaAsset {
  if (!v || typeof v !== 'object') return false;
  const asset = v as Partial<MediaAsset>;
  return typeof asset.id === 'string'
    && typeof asset.name === 'string'
    && (asset.kind === 'video' || asset.kind === 'image' || asset.kind === 'audio')
    && typeof asset.src === 'string'
    && typeof asset.durationInFrames === 'number';
}

function dedupeAssets(values: unknown[]): MediaAsset[] {
  const unique = new Map<string, MediaAsset>();
  for (const value of values) {
    if (isMediaAsset(value) && !unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

function stripTimelineAssets(timeline: Timeline): Timeline {
  const { assets: _legacyAssets, ...rest } = timeline;
  return rest;
}

const tlId = () => `tl_${newId()}`;

/** wrap a single timeline into a one-sequence project (new projects + migration). */
export function docFromTimeline(ts: TimelineState, name = '序列 1'): ProjectDoc {
  const id = tlId();
  const { assets = [], ...state } = ts;
  const timeline: Timeline = { ...state, id, name, order: 0 };
  return { version: 2, assets: dedupeAssets(assets), timelines: [timeline], activeTimelineId: id };
}

/** Normalize every supported persisted shape into ProjectDoc V2. Legacy media
 * pools lived inside timelines, so migration merges/dedupes them at project
 * level and removes the timeline copies. */
export function migrateProjectDoc(v: unknown): ProjectDoc | null {
  if (isProjectDocShape(v)) {
    const legacyAssets = v.timelines.flatMap((timeline) => timeline.assets ?? []);
    const projectAssets = Array.isArray(v.assets) ? v.assets : [];
    const timelines = v.timelines.map(stripTimelineAssets);
    const activeTimelineId = timelines.some((timeline) => timeline.id === v.activeTimelineId)
      ? v.activeTimelineId
      : timelines[0].id;
    return {
      version: 2,
      assets: dedupeAssets([...projectAssets, ...legacyAssets]),
      timelines,
      activeTimelineId,
    };
  }
  if (isTimelineState(v)) return docFromTimeline(v);
  return null;
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

export async function loadProject(id: string): Promise<ProjectDoc | null> {
  try {
    return migrateProjectDoc(await idbGet<unknown>(projectKey(id)));
  } catch {
    return null;
  }
}

/** Save a project's document (all timelines) and bump its index entry's updatedAt. */
export async function saveProject(id: string, doc: ProjectDoc): Promise<void> {
  try {
    await idbSet(projectKey(id), doc);
    const index = await readIndex();
    const entry = index.find((m) => m.id === id);
    if (entry) {
      await idbSet(INDEX_KEY, index.map((m) => (m.id === id ? { ...m, updatedAt: now() } : m)));
    }
  } catch {
    /* ignore persist failures; the session still works in-memory */
  }
}

export async function createProject(name: string, doc: ProjectDoc): Promise<ProjectMeta> {
  const meta: ProjectMeta = { id: newId(), name, updatedAt: now() };
  await idbSet(projectKey(meta.id), doc);
  await idbSet(INDEX_KEY, [meta, ...(await readIndex())]);
  return meta;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const index = await readIndex();
  await idbSet(INDEX_KEY, index.map((m) => (m.id === id ? { ...m, name, updatedAt: now() } : m)));
}

export async function duplicateProject(id: string): Promise<ProjectMeta | null> {
  const doc = await loadProject(id);
  if (!doc) return null;
  const src = (await readIndex()).find((m) => m.id === id);
  return createProject(`${src?.name ?? '工程'} 副本`, doc);
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
