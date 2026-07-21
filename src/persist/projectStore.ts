import type { DesignStyle, ProjectDoc, TimelineState } from '../editor/types';
import type { LlmProvider } from '../../shared/llm-providers';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import {
  kvDel as idbDel,
  kvGet as idbGet,
  kvKeys as idbKeys,
  kvSet as idbSet,
  resetSharedKvMemory,
} from './sharedKv';
import { clearProjectSessionPrefs } from './sessionPrefs';
import { dedupeAssets, isDesignStyle, normalizeTimelineTracks } from './migrations/normalize';
import {
  runProjectMigrations,
  type ProjectMigrationOptions,
  type ProjectMigrationProgress,
} from './migrations';

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

const tlId = () => `tl_${newId()}`;

/** wrap a single timeline into a one-sequence project (new projects + migration). */
export function docFromTimeline(ts: TimelineState, name = '序列 1'): ProjectDoc {
  const id = tlId();
  const { assets = [], ...state } = ts;
  const timeline = normalizeTimelineTracks({ ...state, id, name, order: 0 });
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: dedupeAssets(assets),
    mediaFolders: [],
    timelines: [timeline],
    activeTimelineId: id,
  };
}

/** The sole public boundary for persisted documents, imports, templates and snapshots. */
export function migrateProjectDoc(v: unknown, options?: ProjectMigrationOptions): ProjectDoc | null {
  return runProjectMigrations(v, options)?.doc ?? null;
}

export type { ProjectMigrationOptions, ProjectMigrationProgress };

// ── Ordered per-project chat-history persistence ──────────────────────────
// Stored decoupled from the doc so a chat write never rewrites the timeline (and
// vice-versa). `messages` = the rendered rows; `llm` = provider-neutral AI SDK
// model history. Kept as unknown[] here so this layer stays agnostic of the
// agent types; optional metadata lets the agent migrate older Anthropic history
// and safely remove provider-specific reasoning when the user switches vendors.
const chatKey = (id: string) => `chat:${id}`;

export interface PersistedChat {
  messages: unknown[];
  llm: unknown[];
  llmFormat?: 'ai-sdk-v1';
  llmProvider?: LlmProvider;
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
  /** UI-only cover for style pickers. It is not a generation reference. */
  thumbnailUrl?: string;
  /** Free-form use cases such as "product", "podcast", or "education". */
  scenarios?: string[];
}

function isOwnedStyle(v: unknown): v is OwnedStyle {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<OwnedStyle>;
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && isDesignStyle(o.style)
    && (o.thumbnailUrl === undefined || typeof o.thumbnailUrl === 'string')
    && (o.scenarios === undefined || (Array.isArray(o.scenarios) && o.scenarios.every((s) => typeof s === 'string')));
}

export interface OwnedStyleMetadata {
  thumbnailUrl?: string | null;
  scenarios?: string[];
}

export interface OwnedStyleUpdate extends OwnedStyleMetadata {
  name?: string;
  style?: DesignStyle;
}

const normalizeScenarios = (values: string[] | undefined): string[] | undefined => {
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
};

const uniqueOwnedStyleName = (requested: string, styles: OwnedStyle[], exceptId?: string): string => {
  const base = requested.trim() || '未命名风格';
  const names = new Set(styles.filter((style) => style.id !== exceptId).map((style) => style.name));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
};

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
export async function saveOwnedStyle(
  name: string,
  style: DesignStyle,
  metadata: OwnedStyleMetadata = {},
): Promise<OwnedStyle> {
  const trimmed = name.trim() || '未命名风格';
  const current = await loadOwnedStyles();
  const existing = current.find((s) => s.name === trimmed);
  const thumbnailUrl = metadata.thumbnailUrl === undefined
    ? existing?.thumbnailUrl
    : metadata.thumbnailUrl?.trim() || undefined;
  const scenarios = metadata.scenarios === undefined
    ? existing?.scenarios
    : normalizeScenarios(metadata.scenarios);
  const entry: OwnedStyle = {
    id: existing?.id ?? newId(),
    name: trimmed,
    style,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(scenarios ? { scenarios } : {}),
  };
  const next = existing ? current.map((s) => (s.id === entry.id ? entry : s)) : [...current, entry];
  try {
    await idbSet(OWNED_STYLES_KEY, next);
  } catch {
    /* ignore persist failures; caller still gets the entry back for in-session use */
  }
  return entry;
}

/** Update library metadata or content without replacing/deleting the style entry. */
export async function updateOwnedStyle(id: string, update: OwnedStyleUpdate): Promise<OwnedStyle | undefined> {
  const current = await loadOwnedStyles();
  const existing = current.find((style) => style.id === id);
  if (!existing) return undefined;
  const name = update.name === undefined
    ? existing.name
    : uniqueOwnedStyleName(update.name, current, existing.id);
  const thumbnailUrl = update.thumbnailUrl === undefined
    ? existing.thumbnailUrl
    : update.thumbnailUrl?.trim() || undefined;
  const scenarios = update.scenarios === undefined
    ? existing.scenarios
    : normalizeScenarios(update.scenarios);
  const next: OwnedStyle = {
    id: existing.id,
    name,
    style: update.style ?? existing.style,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(scenarios ? { scenarios } : {}),
  };
  try {
    await idbSet(OWNED_STYLES_KEY, current.map((style) => (style.id === id ? next : style)));
  } catch {
    /* ignore persist failures; caller still gets the updated in-session value */
  }
  return next;
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

export async function loadProject(id: string, options?: ProjectMigrationOptions): Promise<ProjectDoc | null> {
  try {
    const raw = await idbGet<unknown>(projectKey(id));
    let upgraded = false;
    const doc = migrateProjectDoc(raw, {
      onProgress: (progress) => {
        upgraded = true;
        options?.onProgress?.(progress);
      },
    });
    if (!doc) return null;
    // Persist only after the complete chain succeeds. A broken migration leaves
    // the original bytes untouched and can be retried by a future build.
    if (upgraded) {
      try {
        await idbSet(projectKey(id), doc);
      } catch {
        // The migrated in-memory document is still safe to open. Persistence can
        // retry on the next load without ever writing an intermediate version.
      }
    }
    return doc;
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
