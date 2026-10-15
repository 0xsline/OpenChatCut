import {
  isProjectStoreEntries,
  isProjectStoreKey,
  isProjectStoreRecord,
  projectIdFromProjectStoreKey,
} from '../../shared/project-store-validation.ts';
import type { ProjectStoreMutationResponse } from '../../shared/project-store-transport.ts';
import {
  mergeProjectEntries,
  mergeProjectIndex,
  mergeAgentSidecar,
  withoutDeletedProjects,
} from './project-store-entries.ts';
import { createAgentRuntimeStoreOperations } from './project-store-agent-runtime.ts';
import {
  executeImmediateExportRecoveryMutation,
  type ExportRecoveryLeaseInput,
} from './project-store-export-recovery.ts';
import {
  assertAgentSessionMigrationSafe,
  createAgentSessionStoreOperation,
  prepareAgentSessionMigrationEntries,
} from './project-store-agent-session.ts';
import { createProjectDocumentStoreOperation } from './project-store-project-document.ts';
import {
  initializeSqliteProjectStore,
  sqliteDeleteEntry,
  sqliteDeleteProjectEntries,
  sqliteReadAll,
  sqliteReadEntry,
  sqliteImmediateTransaction,
  sqliteWriteAll,
  sqliteWriteEntry,
} from '../storage/sqlite-store.ts';
import { DELETED_PROJECTS_KV_KEY } from '../storage/sqlite-migration.ts';
import { indexStoreKey, removeStoreKey } from '../storage/fulltext-search.ts';
import {
  createProjectStoreEntryAdapter,
  type LockedProjectStore,
  type StoredEntryValue,
} from './project-store-locked.ts';

export type {
  LockedProjectStore,
  StoredEntryValue,
} from './project-store-locked.ts';

const PROJECT_DOCUMENT_KEY = /^project:(.+)$/;
const PROJECT_EDIT_OWNERSHIP_PREFIX = 'project-edit-ownership:';
const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;

interface StoreFile {
  version: 1;
  entries: Record<string, unknown>;
}



async function writeStoredEntry(key: string, value: unknown): Promise<void> {
  await sqliteWriteEntry(key, value);
  indexStoreKey(key, value);
}

async function readDeletedProjects(): Promise<Record<string, number>> {
  const row = await sqliteReadEntry(DELETED_PROJECTS_KV_KEY);
  if (!row.found) return {};
  if (!isProjectStoreRecord(row.value)) throw new Error('invalid deleted project registry');
  const entries = Object.entries(row.value);
  if (!entries.every(([id, deletedAt]) => VALID_PROJECT_ID.test(id) && typeof deletedAt === 'number')) {
    throw new Error('invalid deleted project registry');
  }
  return Object.fromEntries(entries) as Record<string, number>;
}


export async function readStore(): Promise<StoreFile> {
  return serializeProjectStore(async () => {
    await initializeSqliteProjectStore();
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const entries = withoutDeletedProjects(await sqliteReadAll(), deletedIds);
    if (!isProjectStoreEntries(entries)) throw new Error('invalid project store entries');
    return { version: 1, entries };
  });
}

export async function mergeStoredEntries(incoming: Record<string, unknown>): Promise<StoreFile> {
  if (!isProjectStoreEntries(incoming)) throw new Error('invalid project store entries');
  return serializeProjectStore(async () => {
    await initializeSqliteProjectStore();
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const current = await sqliteReadAll();
    await assertAgentSessionMigrationSafe(createLockedProjectStore(deletedIds), current, incoming);
    const prepared = prepareAgentSessionMigrationEntries(current, incoming);
    const next: StoreFile = {
      version: 1,
      entries: mergeProjectEntries(current, prepared, deletedIds),
    };
    await sqliteWriteAll(next.entries);
    for (const [key, value] of Object.entries(next.entries)) {
      if (key.startsWith('chat:') || key.startsWith('project:')) indexStoreKey(key, value);
    }
    return next;
  });
}

export async function setStoredEntry(key: string, value: unknown): Promise<void> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  if (key.startsWith(PROJECT_EDIT_OWNERSHIP_PREFIX)
    || key.startsWith('agent-session-generation:')) {
    throw new Error('project store entry is server-managed');
  }
  await serializeProjectStore(async () => {
    await initializeSqliteProjectStore();
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const projectId = projectIdFromProjectStoreKey(key);
    if (projectId && deletedIds.has(projectId)) return;
    if (key === 'projects') {
      const current = await sqliteReadEntry('projects');
      const safeCurrent = withoutDeletedProjects(
        { projects: current.found ? current.value : [] },
        deletedIds,
      ).projects;
      const safe = withoutDeletedProjects({ projects: value }, deletedIds).projects;
      const merged = mergeProjectIndex(safeCurrent, safe);
      const existing: unknown[] = [];
      for (const item of merged) {
        if (!isProjectStoreRecord(item) || typeof item.id !== 'string') continue;
        const present = (await sqliteReadEntry(`project:${item.id}`)).found;
        if (present) existing.push(item);
      }
      await writeStoredEntry(key, existing);
      return;
    }
    if (key.startsWith('agent-runtime:') || key.startsWith('agent-session-runtime:')
      || key.startsWith('agent-artifact:') || key.startsWith('agent-session-artifact:')) {
      const current = await sqliteReadEntry(key);
      const sidecar = mergeAgentSidecar(key, current.value, value, current.found);
      if (sidecar.accepted) await writeStoredEntry(key, sidecar.value);
      return;
    }
    await writeStoredEntry(key, value);
  });
}


async function purgeProjectLocked(id: string): Promise<void> {
  const deleted = await readDeletedProjects();
  await sqliteWriteEntry(DELETED_PROJECTS_KV_KEY, { ...deleted, [id]: Date.now() });
  await sqliteDeleteProjectEntries(id);
  const current = await sqliteReadEntry('projects');
  const projects = Array.isArray(current.value)
    ? current.value.filter((item) => !isProjectStoreRecord(item) || item.id !== id)
    : [];
  await writeStoredEntry('projects', projects);
}

export async function deleteStoredEntry(key: string): Promise<void> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  if (key.startsWith(PROJECT_EDIT_OWNERSHIP_PREFIX)
    || key.startsWith('agent-session-generation:')) {
    throw new Error('project store entry is server-managed');
  }
  await serializeProjectStore(async () => {
    await initializeSqliteProjectStore();
    const projectId = PROJECT_DOCUMENT_KEY.exec(key)?.[1];
    if (projectId) {
      if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
      await purgeProjectLocked(projectId);
      removeStoreKey(`chat:${projectId}`);
      removeStoreKey(`project:${projectId}`);
    } else {
      await sqliteDeleteEntry(key);
      removeStoreKey(key);
    }
  });
}

const { createLockedProjectStore } = createProjectStoreEntryAdapter({
  writeStoredEntry,
});

export async function getStoredEntry(key: string): Promise<StoredEntryValue> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  await initializeSqliteProjectStore();
  const projectId = projectIdFromProjectStoreKey(key);
  if (projectId && Object.hasOwn(await readDeletedProjects(), projectId)) return { found: false };
  return sqliteReadEntry(key);
}


/**
 * Process-local ordering for project-store operations.
 *
 * The owner-safe cross-process file lease was removed (it caused "guard
 * busy" stalls and is unnecessary for a single-instance app). Within a single
 * process, multi-step store operations (project-document CAS, offline commits,
 * agent-runtime CAS, export-recovery) must still run in order so their
 * read-modify-write steps do not interleave: e.g. a browser editor registered
 * while an offline commit is in flight must observe the post-commit revision
 * (reload) rather than claim a stale frame. This chained promise serializes
 * concurrent project-store mutations in this process. Cross-process
 * safety on SQLite continues to come from WAL + busy_timeout.
 */
let projectStoreTail = Promise.resolve();
function serializeProjectStore<T>(task: () => Promise<T>): Promise<T> {
  const result = projectStoreTail.then(task, task);
  projectStoreTail = result.then(() => undefined, () => undefined);
  return result;
}

export async function withSerializedProjectStore<T>(
  work: (store: LockedProjectStore) => Promise<T>,
): Promise<T> {
  return serializeProjectStore(async () => {
    await initializeSqliteProjectStore();
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    return work(createLockedProjectStore(deletedIds));
  });
}

export const {
  writeAgentRuntime,
  updateStoredAgentRunLease,
} = createAgentRuntimeStoreOperations(withSerializedProjectStore);

export async function updateExportRecoveryLease(
  input: ExportRecoveryLeaseInput,
): Promise<ProjectStoreMutationResponse> {
  await initializeSqliteProjectStore();
  return sqliteImmediateTransaction((store) => (
    executeImmediateExportRecoveryMutation(store, input)
  ));
}

export const writeProjectDocument =
  createProjectDocumentStoreOperation(withSerializedProjectStore);

export const rotateAgentSession = createAgentSessionStoreOperation(withSerializedProjectStore);
