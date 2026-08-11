import type { ProjectDoc, TimelineState } from '../editor/types';
import type { LlmProvider } from '../../shared/llm-providers';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import {
  kvDel as idbDel,
  kvGet as idbGet,
  kvGetLocalFirst as idbGetLocalFirst,
  kvKeys as idbKeys,
  kvSet as idbSet,
  kvPurgeProject,
  resetSharedKvMemory,
} from './sharedKv';
import {
  agentSessionGenerationMatches,
  agentSessionWriteGeneration,
  currentAgentSessionGeneration,
  resetAgentSessionGenerationMemory,
} from './agentSessionGeneration';
import { clearProjectSessionPrefs } from './sessionPrefs';
import { dedupeAssets, normalizeTimelineTracks } from './migrations/normalize';
import {
  runProjectMigrations,
  type ProjectMigrationOptions,
  type ProjectMigrationProgress,
} from './migrations';
import { clearSemanticVectors } from '../media/semantic-search/vectorStore';
import {
  ProjectIndexCoordinator,
  SaveCoordinator,
  type ProjectFlushResult,
  type ProjectIndexMutation,
  type ProjectMeta,
  type ProjectSaveResult,
} from './projectStoreCoordinators';

// Server-backed multi-project store with an IndexedDB cache. The server store is
// shared by every local browser and dev port; Node checks use a memory fallback.
const INDEX_KEY = 'projects';
const projectKey = (id: string) => `project:${id}`;


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
  chatWriteQueues.clear();
  resetSharedKvMemory();
  resetAgentSessionGenerationMemory();
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
const chatKey = (id: string, generation = 'legacy') => generation === 'legacy'
  ? `chat:${id}`
  : `agent-session-chat:${id}:${generation}`;
const chatWriteQueues = new Map<string, Promise<void>>();
const MAX_CHAT_SERVER_RUN_TURN_IDS = 256;


function serializeChatWrite<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const previous = chatWriteQueues.get(projectId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.then(() => undefined, () => undefined);
  chatWriteQueues.set(projectId, settled);
  void settled.finally(() => {
    if (chatWriteQueues.get(projectId) === settled) chatWriteQueues.delete(projectId);
  });
  return run;
}

export interface PersistedChat {
  messages: unknown[];
  llm: unknown[];
  changeLog?: unknown[];
  llmFormat?: 'ai-sdk-v1';
  llmProvider?: LlmProvider;
  toolFailures?: unknown;
  sessionGeneration?: string;
  serverRunTurnIds?: string[];
}

export function isPersistedChat(v: unknown): v is PersistedChat {
  return !!v && typeof v === 'object'
    && Array.isArray((v as { messages?: unknown }).messages)
    && Array.isArray((v as { llm?: unknown }).llm);
}

export async function loadChat(projectId: string): Promise<PersistedChat | null> {
  try {
    await chatWriteQueues.get(projectId);
    const generation = await currentAgentSessionGeneration(projectId);
    const raw = await idbGetLocalFirst<unknown>(chatKey(projectId, generation));
    return isPersistedChat(raw)
      && agentSessionGenerationMatches(raw.sessionGeneration, generation) ? raw : null;
  } catch {
    return null;
  }
}

function serverRunTurnIds(chat: unknown): string[] {
  if (!isPersistedChat(chat) || !Array.isArray(chat.serverRunTurnIds)) return [];
  return chat.serverRunTurnIds.filter((id): id is string => typeof id === 'string')
    .slice(-MAX_CHAT_SERVER_RUN_TURN_IDS);
}

export function saveChat(projectId: string, chat: PersistedChat): Promise<void> {
  const generation = agentSessionWriteGeneration(projectId);
  return serializeChatWrite(projectId, async () => {
    try {
      const sessionGeneration = await generation;
      const key = chatKey(projectId, sessionGeneration);
      const priorIds = serverRunTurnIds(await idbGetLocalFirst<unknown>(key));
      await idbSet(key, {
        ...chat,
        ...(priorIds.length ? { serverRunTurnIds: priorIds } : {}),
        sessionGeneration,
      });
    } catch {
      /* ignore persist failures; the session still works in-memory */
    }
  });
}

export function saveServerRunChat(
  projectId: string,
  runId: string,
  chat: PersistedChat,
): Promise<boolean> {
  const generation = agentSessionWriteGeneration(projectId);
  return serializeChatWrite(projectId, async () => {
    const sessionGeneration = await generation;
    const key = chatKey(projectId, sessionGeneration);
    const existing = await idbGetLocalFirst<unknown>(key);
    const priorIds = serverRunTurnIds(existing);
    if (priorIds.includes(runId)) return false;
    const nextRunIds = [...priorIds, runId].slice(-MAX_CHAT_SERVER_RUN_TURN_IDS);
    await idbSet(key, { ...chat, serverRunTurnIds: nextRunIds, sessionGeneration });
    const stored = await idbGetLocalFirst<unknown>(key);
    if (!serverRunTurnIds(stored).includes(runId)) {
      throw new Error('Server run model history could not be persisted.');
    }
    return true;
  });
}

export async function flushChatWrites(projectId: string): Promise<void> {
  await chatWriteQueues.get(projectId);
}

export function clearChat(projectId: string): Promise<void> {
  return serializeChatWrite(projectId, async () => {
    const generation = await currentAgentSessionGeneration(projectId);
    await idbDel(chatKey(projectId, generation));
  });
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
    return migrateProjectDoc(raw, options);
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

/** Permanently remove project bytes and every project-owned persistence sidecar.
 * Media cleanup remains outside this storage boundary. */
export async function purgeProject(id: string, options?: ProjectPurgeOptions): Promise<void> {
  projectSaveCoordinator.invalidate(id);
  await projectSaveCoordinator.flush(id);
  await clearProjectSemanticVectors(id, options);
  await kvPurgeProject(id);
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
