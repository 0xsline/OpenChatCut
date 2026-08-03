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
import { clearSemanticVectors } from '../media/semantic-search/vectorStore';

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

export interface ProjectSaveResult {
  projectId: string;
  revision: number;
  epoch: number;
  status: 'saved' | 'failed' | 'superseded';
  saved: boolean;
  indexUpdated: boolean;
  error?: unknown;
}

export interface ProjectFlushEntry {
  projectId: string;
  ok: boolean;
  pending: number;
  revision: number;
  result?: ProjectSaveResult;
}

export interface ProjectFlushResult {
  ok: boolean;
  projects: ProjectFlushEntry[];
}

interface ProjectSaveState {
  epoch: number;
  nextRevision: number;
  pending: number;
  tail: Promise<void>;
  lastResult?: ProjectSaveResult;
  blocked?: unknown;
}

type PersistProjectSnapshot = (
  projectId: string,
  snapshot: ProjectDoc,
) => Promise<{ saved: boolean; indexUpdated: boolean }>;

function immutableProjectSnapshot(doc: ProjectDoc): ProjectDoc {
  try {
    return structuredClone(doc);
  } catch {
    // Runtime-only fields such as an in-flight Promise are deliberately absent
    // from persisted ProjectDoc JSON.
    return JSON.parse(JSON.stringify(doc)) as ProjectDoc;
  }
}

/**
 * Per-project save queue. A snapshot is captured before enqueue, every writer
 * for one project runs in revision order, and a rejected write never poisons the
 * tail used by subsequent saves.
 */
export class SaveCoordinator {
  private readonly states = new Map<string, ProjectSaveState>();
  private readonly persist: PersistProjectSnapshot;
  private readonly snapshot: (doc: ProjectDoc) => ProjectDoc;

  constructor(
    persist: PersistProjectSnapshot,
    snapshot: (doc: ProjectDoc) => ProjectDoc = immutableProjectSnapshot,
  ) {
    this.persist = persist;
    this.snapshot = snapshot;
  }

  private stateFor(projectId: string): ProjectSaveState {
    let state = this.states.get(projectId);
    if (!state) {
      state = { epoch: 0, nextRevision: 0, pending: 0, tail: Promise.resolve() };
      this.states.set(projectId, state);
    }
    return state;
  }

  enqueue(projectId: string, doc: ProjectDoc): Promise<ProjectSaveResult> {
    const state = this.stateFor(projectId);
    if (state.blocked !== undefined) {
      return Promise.resolve({
        projectId,
        revision: state.nextRevision,
        epoch: state.epoch,
        status: 'failed',
        saved: false,
        indexUpdated: false,
        error: state.blocked,
      });
    }
    const snapshot = this.snapshot(doc);
    const revision = ++state.nextRevision;
    const epoch = state.epoch;
    state.pending += 1;

    const run = async (): Promise<ProjectSaveResult> => {
      if (state.epoch !== epoch) {
        return {
          projectId, revision, epoch, status: 'superseded',
          saved: false, indexUpdated: false,
        };
      }
      try {
        const persisted = await this.persist(projectId, snapshot);
        if (!persisted.saved) {
          return {
            projectId, revision, epoch, status: 'failed',
            saved: false, indexUpdated: persisted.indexUpdated,
            error: new Error('project save failed'),
          };
        }
        return {
          projectId, revision, epoch, status: 'saved',
          saved: true, indexUpdated: persisted.indexUpdated,
        };
      } catch (error) {
        return {
          projectId, revision, epoch, status: 'failed',
          saved: false, indexUpdated: false, error,
        };
      }
    };

    const result = state.tail.then(run);
    state.tail = result.then((value) => {
      state.lastResult = value;
      state.pending -= 1;
    }, (error) => {
      state.lastResult = {
        projectId, revision, epoch, status: 'failed',
        saved: false, indexUpdated: false, error,
      };
      state.pending -= 1;
    });
    return result;
  }

  async flush(projectId: string | 'all' = 'all'): Promise<ProjectFlushResult> {
    const ids = projectId === 'all' ? [...this.states.keys()] : [projectId];
    const projects = await Promise.all(ids.map(async (id): Promise<ProjectFlushEntry> => {
      const state = this.states.get(id);
      if (!state) return { projectId: id, ok: true, pending: 0, revision: 0 };
      for (;;) {
        const tail = state.tail;
        await tail;
        if (state.pending === 0 && state.tail === tail) break;
      }
      const result = state.lastResult;
      return {
        projectId: id,
        ok: state.blocked === undefined && result?.status !== 'failed',
        pending: state.pending,
        revision: state.nextRevision,
        ...(result ? { result } : {}),
      };
    }));
    return { ok: projects.every((entry) => entry.ok), projects };
  }

  hasPending(projectId?: string): boolean {
    if (projectId !== undefined) return (this.states.get(projectId)?.pending ?? 0) > 0;
    return [...this.states.values()].some((state) => state.pending > 0);
  }

  hasFailure(projectId?: string): boolean {
    const failed = (state: ProjectSaveState | undefined) =>
      state?.blocked !== undefined || (state?.pending === 0 && state.lastResult?.status === 'failed');
    if (projectId !== undefined) return failed(this.states.get(projectId)) === true;
    return [...this.states.values()].some(failed);
  }

  /**
   * Permanently close a project's queue before destructive removal. Existing
   * writers may finish, but new snapshots are rejected until the store resets.
   */
  invalidate(projectId: string): void {
    const state = this.stateFor(projectId);
    state.epoch += 1;
    state.blocked = new Error('project save queue was invalidated');
  }

  reset(): void {
    this.states.clear();
  }
}

export interface ProjectIndexMutation<T> {
  /** null means the operation was a read/no-op and must not rewrite INDEX_KEY. */
  next: ProjectMeta[] | null;
  value: T;
}

type ReadProjectIndex = () => Promise<ProjectMeta[]>;
type WriteProjectIndex = (index: ProjectMeta[]) => Promise<void>;

/**
 * One recoverable queue owns every INDEX_KEY read-modify-write transaction.
 * Project document writes remain independent; only their index commit is
 * serialized with metadata, create, delete, restore, and purge mutations.
 */
export class ProjectIndexCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly readStore: ReadProjectIndex;
  private readonly writeStore: WriteProjectIndex;

  constructor(readStore: ReadProjectIndex, writeStore: WriteProjectIndex) {
    this.readStore = readStore;
    this.writeStore = writeStore;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => undefined).then(operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  read(): Promise<ProjectMeta[]> {
    return this.enqueue(() => this.readStore());
  }

  mutate<T>(
    operation: (current: ProjectMeta[]) => ProjectIndexMutation<T> | Promise<ProjectIndexMutation<T>>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.readStore();
      const mutation = await operation(current);
      if (mutation.next !== null) await this.writeStore(mutation.next);
      return mutation.value;
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  reset(): void {
    this.tail = Promise.resolve();
  }
}

async function persistProjectSnapshot(
  id: string,
  doc: ProjectDoc,
): Promise<{ saved: boolean; indexUpdated: boolean }> {
  try {
    await idbSet(projectKey(id), doc);
  } catch {
    return { saved: false, indexUpdated: false };
  }
  try {
    const indexUpdated = await mutateProjectIndex((index) => {
      if (!index.some((meta) => meta.id === id)) return { next: null, value: false };
      const updatedAt = now();
      return {
        next: index.map((meta) => (meta.id === id ? { ...meta, updatedAt } : meta)),
        value: true,
      };
    });
    return { saved: true, indexUpdated };
  } catch {
    return { saved: true, indexUpdated: false };
  }
}

export const projectSaveCoordinator = new SaveCoordinator(persistProjectSnapshot);

/** Test helper: wipe in-memory fallback (no-op when IDB is real). */
export function resetProjectStoreMemory(): void {
  projectSaveCoordinator.reset();
  projectIndexCoordinator.reset();
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
  changeLog?: unknown[];
  llmFormat?: 'ai-sdk-v1';
  llmProvider?: LlmProvider;
  toolFailures?: unknown;
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

async function readIndexStore(): Promise<ProjectMeta[]> {
  const raw = await idbGet<unknown>(INDEX_KEY);
  return Array.isArray(raw) ? (raw as ProjectMeta[]).filter((m) => m && typeof m.id === 'string') : [];
}

export const projectIndexCoordinator = new ProjectIndexCoordinator(
  readIndexStore,
  (index) => idbSet(INDEX_KEY, index),
);

function readIndex(): Promise<ProjectMeta[]> {
  return projectIndexCoordinator.read();
}

function mutateProjectIndex<T>(
  operation: (current: ProjectMeta[]) => ProjectIndexMutation<T> | Promise<ProjectIndexMutation<T>>,
): Promise<T> {
  return projectIndexCoordinator.mutate(operation);
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

/**
 * The original persistent bytes of the project, without migration. Only for those who want to rescue asset references when the document cannot be read.
 * Use the back-up path—normally use loadProject when reading projects.
 */
export async function loadRawProject(id: string): Promise<unknown> {
  try {
    return await idbGet<unknown>(projectKey(id));
  } catch {
    return null;
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

/** Capture and enqueue a project's document; writes for the same project never overlap. */
export function saveProject(id: string, doc: ProjectDoc): Promise<ProjectSaveResult> {
  return projectSaveCoordinator.enqueue(id, doc);
}

export function flushProjectSaves(projectId: string | 'all' = 'all'): Promise<ProjectFlushResult> {
  return projectSaveCoordinator.flush(projectId);
}

export function hasPendingProjectSaves(projectId?: string): boolean {
  return projectSaveCoordinator.hasPending(projectId);
}

export function hasProjectSaveFailure(projectId?: string): boolean {
  return projectSaveCoordinator.hasFailure(projectId);
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
  await mutateProjectIndex((index) => ({
    next: [meta, ...index.filter((entry) => entry.id !== meta.id)],
    value: undefined,
  }));
  return meta;
}

export async function renameProject(id: string, name: string): Promise<void> {
  await mutateProjectIndex((index) => {
    if (!index.some((meta) => meta.id === id)) return { next: null, value: undefined };
    const updatedAt = now();
    return {
      next: index.map((meta) => (meta.id === id ? { ...meta, name, updatedAt } : meta)),
      value: undefined,
    };
  });
}

export async function updateProjectMeta(
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<ProjectMeta | null> {
  return mutateProjectIndex((index) => {
    const entry = index.find((meta) => meta.id === id);
    if (!entry) return { next: null, value: null };
    const next: ProjectMeta = {
      ...entry,
      updatedAt: now(),
      ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
    };
    if (patch.description === null) delete next.description;
    else if (typeof patch.description === 'string') next.description = patch.description;
    return {
      next: index.map((meta) => (meta.id === id ? next : meta)),
      value: next,
    };
  });
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
// ── Project card poster frame cache (key=updatedAt, re-rendering will be invalidated as soon as the project changes) ──────────────────
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
  await mutateProjectIndex((index) => {
    if (!index.some((meta) => meta.id === id)) return { next: null, value: undefined };
    const deletedAt = now();
    return {
      next: index.map((meta) => (
        meta.id === id ? { ...meta, deletedAt, updatedAt: deletedAt } : meta
      )),
      value: undefined,
    };
  });
}

/** Undo a soft delete. */
export async function restoreProject(id: string): Promise<ProjectMeta | null> {
  return mutateProjectIndex((index) => {
    const entry = index.find((meta) => meta.id === id);
    if (!entry) return { next: null, value: null };
    const next: ProjectMeta = { ...entry, updatedAt: now() };
    delete next.deletedAt;
    return {
      next: index.map((meta) => (meta.id === id ? next : meta)),
      value: next,
    };
  });
}

export interface ProjectPurgeOptions {
  /** Test/server seam; browsers default to the semantic IndexedDB cleanup. */
  semanticCleanup?: (scopeId: string) => Promise<void>;
}

async function clearProjectSemanticVectors(id: string, options?: ProjectPurgeOptions): Promise<void> {
  if (options?.semanticCleanup) {
    await options.semanticCleanup(id);
    return;
  }
  if (typeof indexedDB !== 'undefined') await clearSemanticVectors(id);
}

/** Permanently remove project bytes (not exposed as agent tool; dashboard cascade uses this).
 * Clear all data keyed by project: doc/chat/creation mode/proposal/version (the last two keys belong to proposalStore/versionStore
 * All, delete them literally here to avoid mutual import of persistence layers). Even if the index does not have the id, it will be deleted - orphan document (smoke test)
 * Residues) rely on this to clear.*/
export async function purgeProject(id: string, options?: ProjectPurgeOptions): Promise<void> {
  projectSaveCoordinator.invalidate(id);
  await projectSaveCoordinator.flush(id);
  await clearProjectSemanticVectors(id, options);
  await idbDel(projectKey(id));
  await idbDel(chatKey(id));
  await idbDel(creativeModeKey(id));
  await idbDel(`thumb:${id}`);
  await idbDel(`proposal:${id}`);
  await idbDel(`versions:${id}`);
  await idbDel(`jobs:${id}`);
  await idbDel(`review:${id}`);
  await mutateProjectIndex((index) => ({
    next: index.filter((meta) => meta.id !== id),
    value: undefined,
  }));
  clearProjectSessionPrefs(id);
}

/** All project:<id> ids of documents (including orphans outside the index - smoke/old test remnants).*/
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
