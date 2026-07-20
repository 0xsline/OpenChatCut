import { timelineTrackIds, trackKind, type DesignStyle, type MediaAsset, type MediaFolder, type ProjectDoc, type Timeline, type TimelineState } from '../editor/types';
import {
  kvDel as idbDel,
  kvGet as idbGet,
  kvKeys as idbKeys,
  kvSet as idbSet,
  resetSharedKvMemory,
} from './sharedKv';
import { clearProjectSessionPrefs } from './sessionPrefs';

// Server-backed multi-project store with an IndexedDB cache. The server store is
// shared by every local browser and dev port; Node checks use a memory fallback.
const INDEX_KEY = 'projects';
const projectKey = (id: string) => `project:${id}`;

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  /** Soft-delete timestamp; absent means active. */
  deletedAt?: number;
  /** Optional free-text project description. */
  description?: string;
}

/** Test helper: wipe in-memory fallback (no-op when IDB is real). */
export function resetProjectStoreMemory(): void {
  resetSharedKvMemory();
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
  mediaFolders?: unknown;
  timelines: Timeline[];
  activeTimelineId: string;
  designStyle?: unknown;
};

// design style is untrusted persisted data — accept only the array-of-roles shape
// Anything else is dropped rather than trusted.
function isDesignStyle(v: unknown): v is DesignStyle {
  if (!v || typeof v !== 'object') return false;
  const s = v as { colors?: unknown; fonts?: unknown };
  return Array.isArray(s.colors) && Array.isArray(s.fonts);
}

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
    && (asset.kind === 'video' || asset.kind === 'image' || asset.kind === 'audio' || asset.kind === 'motion-graphic')
    && typeof asset.src === 'string'
    && typeof asset.durationInFrames === 'number'
    && (asset.kind !== 'motion-graphic' || typeof asset.code === 'string');
}

function dedupeAssets(values: unknown[]): MediaAsset[] {
  const unique = new Map<string, MediaAsset>();
  for (const value of values) {
    if (isMediaAsset(value) && !unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

function isMediaFolder(v: unknown): v is MediaFolder {
  if (!v || typeof v !== 'object') return false;
  const folder = v as Partial<MediaFolder>;
  return typeof folder.id === 'string' && typeof folder.name === 'string'
    && (folder.parentId === undefined || typeof folder.parentId === 'string');
}

function stripTimelineAssets(timeline: Timeline): Timeline {
  const { assets: _legacyAssets, ...rest } = timeline;
  return rest;
}

/** One-time legacy migration: aliases used to be item ids. Replace them with
 * deterministic stable ids so V1/V2/A1/A2 may safely renumber after inserts. */
function normalizeTimelineTracks(timeline: Timeline): Timeline {
  const clean = stripTimelineAssets(timeline);
  const ids = timelineTrackIds(clean);
  const alreadyStable = !!clean.trackOrder?.length
    && ids.every((id) => clean.tracks?.[id]?.kind === 'video' || clean.tracks?.[id]?.kind === 'audio');
  if (alreadyStable) return clean;
  const remap = new Map(ids.map((id, index) => [id, `track_${clean.id}_${index + 1}`]));
  const trackOrder = ids.map((id) => remap.get(id)!);
  const tracks = Object.fromEntries(ids.map((id) => {
    const nextId = remap.get(id)!;
    return [nextId, { ...clean.tracks?.[id], kind: trackKind(clean, id) }];
  }));
  return {
    ...clean,
    trackOrder,
    tracks,
    items: clean.items.map((item) => ({ ...item, track: remap.get(item.track) ?? item.track })),
    transitions: clean.transitions?.map((transition) => ({ ...transition, trackId: remap.get(transition.trackId) ?? transition.trackId })),
  };
}

const tlId = () => `tl_${newId()}`;

/** wrap a single timeline into a one-sequence project (new projects + migration). */
export function docFromTimeline(ts: TimelineState, name = '序列 1'): ProjectDoc {
  const id = tlId();
  const { assets = [], ...state } = ts;
  const timeline = normalizeTimelineTracks({ ...state, id, name, order: 0 });
  return { version: 2, assets: dedupeAssets(assets), mediaFolders: [], timelines: [timeline], activeTimelineId: id };
}

/** Normalize every supported persisted shape into ProjectDoc V2. Legacy media
 * pools lived inside timelines, so migration merges/dedupes them at project
 * level and removes the timeline copies. */
export function migrateProjectDoc(v: unknown): ProjectDoc | null {
  if (isProjectDocShape(v)) {
    const legacyAssets = v.timelines.flatMap((timeline) => timeline.assets ?? []);
    const projectAssets = Array.isArray(v.assets) ? v.assets : [];
    const rawFolders = Array.isArray(v.mediaFolders) ? v.mediaFolders.filter(isMediaFolder) : [];
    const folderIds = new Set(rawFolders.map((folder) => folder.id));
    const mediaFolders = rawFolders.map((folder) => folder.parentId && (!folderIds.has(folder.parentId) || folder.parentId === folder.id)
      ? { ...folder, parentId: undefined }
      : folder);
    const assets = dedupeAssets([...projectAssets, ...legacyAssets]).map((asset) => asset.folderId && !folderIds.has(asset.folderId)
      ? { ...asset, folderId: undefined }
      : asset);
    const timelines = v.timelines.map(normalizeTimelineTracks);
    const activeTimelineId = timelines.some((timeline) => timeline.id === v.activeTimelineId)
      ? v.activeTimelineId
      : timelines[0].id;
    return {
      version: 2,
      assets,
      mediaFolders,
      timelines,
      activeTimelineId,
      ...(isDesignStyle(v.designStyle) ? { designStyle: v.designStyle } : {}),
    };
  }
  if (isTimelineState(v)) return docFromTimeline(v);
  return null;
}

// ── Ordered per-project chat-history persistence ──────────────────────────
// Stored decoupled from the doc so a chat write never rewrites the timeline (and
// vice-versa). `messages` = the rendered rows; `llm` = the Anthropic history the
// agent continues from. Kept as unknown[] here so this layer stays agnostic of
// the agent types (the agent layer validates/casts on read).
const chatKey = (id: string) => `chat:${id}`;

export interface PersistedChat {
  messages: unknown[];
  llm: unknown[];
}

export function isPersistedChat(v: unknown): v is PersistedChat {
  return !!v && typeof v === 'object'
    && Array.isArray((v as { messages?: unknown }).messages)
    && Array.isArray((v as { llm?: unknown }).llm);
}

export async function loadChat(projectId: string): Promise<PersistedChat | null> {
  try {
    const raw = await idbGet<unknown>(chatKey(projectId));
    return isPersistedChat(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function saveChat(projectId: string, chat: PersistedChat): Promise<void> {
  try {
    await idbSet(chatKey(projectId), chat);
  } catch {
    /* ignore persist failures; the session still works in-memory */
  }
}

export async function clearChat(projectId: string): Promise<void> {
  try {
    await idbDel(chatKey(projectId));
  } catch {
    /* ignore */
  }
}

// ── Creative mode: which skill is active for a project.
// A UI/session preference, kept OUT of the undo-able ProjectDoc; one id per project. ──
const creativeModeKey = (id: string) => `creative-mode:${id}`;

export async function loadCreativeMode(projectId: string): Promise<string | null> {
  try {
    const raw = await idbGet<unknown>(creativeModeKey(projectId));
    return typeof raw === 'string' && raw ? raw : null;
  } catch {
    return null;
  }
}

export async function saveCreativeMode(projectId: string, skillId: string | null): Promise<void> {
  try {
    if (skillId) await idbSet(creativeModeKey(projectId), skillId);
    else await idbDel(creativeModeKey(projectId));
  } catch {
    /* ignore persist failures; the session still works in-memory */
  }
}

// ── Owned design styles: the user's saved
// styles — a single GLOBAL personal library (not scoped to a project), stored
// under one key alongside the catalog presets in design-presets.ts. ──
const OWNED_STYLES_KEY = 'design-styles:owned';

export interface OwnedStyle {
  id: string;
  name: string;
  style: DesignStyle;
}

function isOwnedStyle(v: unknown): v is OwnedStyle {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<OwnedStyle>;
  return typeof o.id === 'string' && typeof o.name === 'string' && isDesignStyle(o.style);
}

/** The user's saved style library. Corrupt/partial persisted data is dropped, not trusted. */
export async function loadOwnedStyles(): Promise<OwnedStyle[]> {
  try {
    const raw = await idbGet<unknown>(OWNED_STYLES_KEY);
    return Array.isArray(raw) ? raw.filter(isOwnedStyle) : [];
  } catch {
    return [];
  }
}

/** Save a style under `name` (replacing any existing entry with the same name). */
export async function saveOwnedStyle(name: string, style: DesignStyle): Promise<OwnedStyle> {
  const trimmed = name.trim() || '未命名风格';
  const current = await loadOwnedStyles();
  const existing = current.find((s) => s.name === trimmed);
  const entry: OwnedStyle = { id: existing?.id ?? newId(), name: trimmed, style };
  const next = existing ? current.map((s) => (s.id === entry.id ? entry : s)) : [...current, entry];
  try {
    await idbSet(OWNED_STYLES_KEY, next);
  } catch {
    /* ignore persist failures; caller still gets the entry back for in-session use */
  }
  return entry;
}

export async function deleteOwnedStyle(id: string): Promise<void> {
  try {
    const current = await loadOwnedStyles();
    await idbSet(OWNED_STYLES_KEY, current.filter((s) => s.id !== id));
  } catch {
    /* ignore */
  }
}

async function readIndex(): Promise<ProjectMeta[]> {
  const raw = await idbGet<unknown>(INDEX_KEY);
  return Array.isArray(raw) ? (raw as ProjectMeta[]).filter((m) => m && typeof m.id === 'string') : [];
}

/** Projects for the dashboard / agent, newest-edited first.
 * Soft-deleted projects are hidden unless `includeDeleted: true`. */
export async function listProjects(opts?: { includeDeleted?: boolean }): Promise<ProjectMeta[]> {
  try {
    const all = await readIndex();
    const filtered = opts?.includeDeleted ? all : all.filter((m) => !m.deletedAt);
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Whether this shared store has ever contained a project, even if the user deleted all of them. */
export async function hasProjectHistory(): Promise<boolean> {
  try {
    return (await idbKeys()).includes(INDEX_KEY);
  } catch {
    return false;
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

export async function createProject(
  name: string,
  doc: ProjectDoc,
  opts?: { description?: string },
): Promise<ProjectMeta> {
  const meta: ProjectMeta = {
    id: newId(),
    name,
    updatedAt: now(),
    ...(opts?.description ? { description: opts.description } : {}),
  };
  await idbSet(projectKey(meta.id), doc);
  await idbSet(INDEX_KEY, [meta, ...(await readIndex())]);
  return meta;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const index = await readIndex();
  await idbSet(INDEX_KEY, index.map((m) => (m.id === id ? { ...m, name, updatedAt: now() } : m)));
}

export async function updateProjectMeta(
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<ProjectMeta | null> {
  const index = await readIndex();
  const entry = index.find((m) => m.id === id);
  if (!entry) return null;
  const next: ProjectMeta = {
    ...entry,
    updatedAt: now(),
    ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
  };
  if (patch.description === null) delete next.description;
  else if (typeof patch.description === 'string') next.description = patch.description;
  await idbSet(INDEX_KEY, index.map((m) => (m.id === id ? next : m)));
  return next;
}

export async function duplicateProject(id: string, name?: string): Promise<ProjectMeta | null> {
  const doc = await loadProject(id);
  if (!doc) return null;
  // Allow duplicating soft-deleted sources too (copy is active).
  const src = (await readIndex()).find((m) => m.id === id);
  const copyName = (name?.trim() || `[Copy] ${src?.name ?? '工程'}`);
  return createProject(copyName, doc, src?.description ? { description: src.description } : undefined);
}

/** Soft-delete: hide from dashboard/list; data kept for restore_project. */
// ── 工程卡海报帧缓存(key=updatedAt,工程一变即失效重渲) ──────────────────
interface ProjectThumb {
  key: number;
  dataUrl: string;
}

export async function loadProjectThumb(id: string): Promise<ProjectThumb | null> {
  const v = await idbGet<ProjectThumb>(`thumb:${id}`);
  return v && typeof v.dataUrl === 'string' && typeof v.key === 'number' ? v : null;
}

export async function saveProjectThumb(id: string, key: number, dataUrl: string): Promise<void> {
  await idbSet(`thumb:${id}`, { key, dataUrl });
}

export async function deleteProject(id: string): Promise<void> {
  const index = await readIndex();
  if (!index.some((m) => m.id === id)) return;
  await idbSet(
    INDEX_KEY,
    index.map((m) => (m.id === id ? { ...m, deletedAt: now(), updatedAt: now() } : m)),
  );
}

/** Undo a soft delete. */
export async function restoreProject(id: string): Promise<ProjectMeta | null> {
  const index = await readIndex();
  const entry = index.find((m) => m.id === id);
  if (!entry) return null;
  const next: ProjectMeta = { ...entry, updatedAt: now() };
  delete next.deletedAt;
  await idbSet(INDEX_KEY, index.map((m) => (m.id === id ? next : m)));
  return next;
}

/** Permanently remove project bytes (not exposed as agent tool; dashboard cascade uses this).
 * 清全部按工程分key的数据:doc/聊天/创作模式/提案/版本(后两个键归 proposalStore/versionStore
 * 所有,此处按字面删,避免持久层互相 import)。索引没有该 id 也照删——孤儿文档(冒烟测试
 * 残留)靠这个清。 */
export async function purgeProject(id: string): Promise<void> {
  await idbDel(projectKey(id));
  await idbDel(chatKey(id));
  await idbDel(creativeModeKey(id));
  await idbDel(`thumb:${id}`);
  await idbDel(`proposal:${id}`);
  await idbDel(`versions:${id}`);
  await idbDel(`jobs:${id}`);
  await idbSet(INDEX_KEY, (await readIndex()).filter((m) => m.id !== id));
  clearProjectSessionPrefs(id);
}

/** 全部 project:<id> 文档的 id(含索引之外的孤儿——冒烟/旧测试残留)。 */
export async function listProjectDocIds(): Promise<string[]> {
  try {
    return (await idbKeys()).filter((k) => k.startsWith('project:')).map((k) => k.slice('project:'.length));
  } catch {
    return [];
  }
}

const now = () => Date.now();
const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `p_${now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

// Auto-name new empty projects with a generated adjective/noun combination.
const ADJ = ['流光', '静默', '暖阳', '深蓝', '轻盈', '锋利', '柔和', '斑斓', '清冽', '灼热', '朦胧', '澄澈'];
const NOUN = ['序曲', '航迹', '棱镜', '潮汐', '织机', '回响', '飞羽', '砂丘', '苔原', '穹顶', '流域', '星图'];
export function randomProjectName(): string {
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJ)}${pick(NOUN)}`;
}
