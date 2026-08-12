import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isProjectStoreEntries,
  isProjectStoreKey,
  isProjectStoreRecord,
  projectIdFromProjectStoreKey,
} from '../../shared/project-store-validation.ts';
import type { ProjectStoreMutationResponse } from '../../shared/project-store-transport.ts';
import { runtimeProfile } from '../runtime-profile.ts';
import {
  mergeProjectEntries,
  mergeProjectIndex,
  mergeAgentSidecar,
  withoutDeletedProjects,
} from './project-store-entries.ts';
import { createAgentRuntimeStoreOperations } from './project-store-agent-runtime.ts';
import {
  createExportRecoveryLeaseOperation,
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
  sqliteStoreEnabled,
  sqliteImmediateTransaction,
  sqliteWriteAll,
  sqliteWriteEntry,
} from '../storage/sqlite-store.ts';
import { DELETED_PROJECTS_KV_KEY } from '../storage/sqlite-migration.ts';
import { indexStoreKey, removeStoreKey } from '../storage/fulltext-search.ts';
import {
  atomicWriteFile,
  atomicWriteJson,
  durableMkdir,
  durableRemove,
  durableRename,
} from './project-store-durable.ts';
import {
  createProjectStoreEntryAdapter,
  type LockedProjectStore,
  type StoredEntryValue,
} from './project-store-locked.ts';

export type {
  LockedProjectStore,
  StoredEntryValue,
} from './project-store-locked.ts';

const {
  legacyStorePath: LEGACY_STORE_PATH,
  legacyBackupPath: LEGACY_BACKUP_PATH,
  directory: STORE_DIR,
  indexPath: INDEX_PATH,
  quarantineDir: QUARANTINE_DIR,
  readyPath: READY_PATH,
  tombstonePath: DELETED_PROJECTS_PATH,
} = runtimeProfile().projectStore;
const PROJECT_DOCUMENT_KEY = /^project:(.+)$/;
const PROJECT_EDIT_OWNERSHIP_PREFIX = 'project-edit-ownership:';
const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;

interface StoreFile {
  version: 1;
  entries: Record<string, unknown>;
}


async function readLegacyStore(): Promise<{ exists: boolean; store: StoreFile }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(LEGACY_STORE_PATH, 'utf8'));
    if (!isProjectStoreRecord(parsed) || parsed.version !== 1 || !isProjectStoreEntries(parsed.entries)) {
      throw new Error('invalid legacy project store');
    }
    return { exists: true, store: { version: 1, entries: parsed.entries } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, store: { version: 1, entries: {} } };
    }
    throw error;
  }
}

const entryPath = (key: string) => key === 'projects'
  ? INDEX_PATH
  : join(STORE_DIR, `${encodeURIComponent(key)}.json`);

async function writeStoredEntry(key: string, value: unknown): Promise<void> {
  if (sqliteStoreEnabled()) {
    await sqliteWriteEntry(key, value);
    indexStoreKey(key, value);
    return;
  }
  await atomicWriteJson(entryPath(key), value);
}
interface QuarantinedEntry {
  version: 1;
  kind: 'quarantined-project-store-entry';
  key: string;
  quarantinedAt: number;
  quarantineFile: string;
}

async function quarantineUnknownEntryFile(file: string): Promise<void> {
  await durableMkdir(QUARANTINE_DIR, true);
  await durableRename(
    join(STORE_DIR, file),
    join(QUARANTINE_DIR, `${file}.${randomUUID()}.corrupt`),
  );
}

async function quarantineEntryFile(file: string, key: string): Promise<QuarantinedEntry> {
  const quarantineFile = `${file}.${Date.now()}.${randomUUID()}.corrupt`;
  await durableMkdir(QUARANTINE_DIR, true);
  await durableRename(join(STORE_DIR, file), join(QUARANTINE_DIR, quarantineFile));
  const marker: QuarantinedEntry = {
    version: 1,
    kind: 'quarantined-project-store-entry',
    key,
    quarantinedAt: Date.now(),
    quarantineFile,
  };
  await atomicWriteJson(entryPath(key), marker);
  return marker;
}

async function readDeletedProjects(): Promise<Record<string, number>> {
  if (sqliteStoreEnabled()) {
    const row = await sqliteReadEntry(DELETED_PROJECTS_KV_KEY);
    if (!row.found) return {};
    const parsed = row.value;
    if (!isProjectStoreRecord(parsed)) throw new Error('invalid deleted project registry');
    const entries = Object.entries(parsed);
    if (!entries.every(([id, deletedAt]) => VALID_PROJECT_ID.test(id) && typeof deletedAt === 'number')) {
      throw new Error('invalid deleted project registry');
    }
    return Object.fromEntries(entries) as Record<string, number>;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(DELETED_PROJECTS_PATH, 'utf8'));
    if (!isProjectStoreRecord(parsed)) throw new Error('invalid deleted project registry');
    const entries = Object.entries(parsed);
    if (!entries.every(([id, deletedAt]) => VALID_PROJECT_ID.test(id) && typeof deletedAt === 'number')) {
      throw new Error('invalid deleted project registry');
    }
    return Object.fromEntries(entries) as Record<string, number>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeDeletedProjects(projects: Record<string, number>): Promise<void> {
  if (sqliteStoreEnabled()) {
    await sqliteWriteEntry(DELETED_PROJECTS_KV_KEY, projects);
    return;
  }
  await atomicWriteJson(DELETED_PROJECTS_PATH, projects);
}

async function writeEntries(entries: Record<string, unknown>): Promise<void> {
  if (sqliteStoreEnabled()) {
    await sqliteWriteAll(entries);
    return;
  }
  await durableMkdir(STORE_DIR, true);
  const ordered = Object.entries(entries).sort(([left], [right]) => {
    if (left === 'projects') return 1;
    if (right === 'projects') return -1;
    return left.localeCompare(right);
  });
  for (const [key, value] of ordered) await writeStoredEntry(key, value);
}

async function readDirectoryEntries(): Promise<Record<string, unknown>> {
  if (sqliteStoreEnabled()) return sqliteReadAll();
  const entries: Record<string, unknown> = {};
  for (const file of await readdir(STORE_DIR)) {
    if (!file.endsWith('.json')) continue;
    let key: string;
    try {
      key = decodeURIComponent(file.slice(0, -'.json'.length));
    } catch {
      await quarantineUnknownEntryFile(file);
      continue;
    }
    if (!isProjectStoreKey(key)) {
      await quarantineUnknownEntryFile(file);
      continue;
    }
    const raw = await readFile(join(STORE_DIR, file), 'utf8');
    try {
      entries[key] = JSON.parse(raw);
    } catch {
      entries[key] = await quarantineEntryFile(file, key);
    }
  }
  return entries;
}

async function acquireLock(): Promise<() => Promise<void>> {
  // SQLite backend owns all project-store reads/writes: WAL + busy_timeout(5000)
  // provide multi-read concurrency and serialized writes themselves, so no
  // cross-process file lock is needed (and the old owner-safe lease could stall
  // every other browser/tab with "project store busy"/"guard busy").
  return async () => {};
}

async function readyExists(): Promise<boolean> {
  try {
    await access(READY_PATH);
    return true;
  } catch {
    return false;
  }
}

async function migrateLegacyLocked(): Promise<void> {
  if (await readyExists()) return;
  const legacy = await readLegacyStore();
  await writeEntries(legacy.store.entries);
  await atomicWriteFile(READY_PATH, '1\n');
  if (!legacy.exists) return;
  await durableRemove(LEGACY_BACKUP_PATH);
  await durableRename(LEGACY_STORE_PATH, LEGACY_BACKUP_PATH);
}

async function ensureStoreReady(): Promise<void> {
  await initializeSqliteProjectStore();
  // SQLite backend: no JSON dir / .ready / legacy-file migration needed; the
  // database self-creates its directory and schema (phase 1 adds import).
  if (sqliteStoreEnabled()) return;
  if (await readyExists()) return;
  const release = await acquireLock();
  try {
    await migrateLegacyLocked();
  } finally {
    await release();
  }
}

export async function readStore(): Promise<StoreFile> {
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const entries = withoutDeletedProjects(await readDirectoryEntries(), deletedIds);
    if (!isProjectStoreEntries(entries)) throw new Error('invalid project store entries');
    return { version: 1, entries };
  } finally {
    await release();
  }
}

export async function mergeStoredEntries(incoming: Record<string, unknown>): Promise<StoreFile> {
  if (!isProjectStoreEntries(incoming)) throw new Error('invalid project store entries');
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const current = await readDirectoryEntries();
    await assertAgentSessionMigrationSafe(createLockedProjectStore(deletedIds), current, incoming);
    const prepared = prepareAgentSessionMigrationEntries(current, incoming);
    const next: StoreFile = {
      version: 1,
      entries: mergeProjectEntries(current, prepared, deletedIds),
    };
    await writeEntries(next.entries);
    for (const [key, value] of Object.entries(next.entries)) {
      if (key.startsWith('chat:') || key.startsWith('project:')) indexStoreKey(key, value);
    }
    return next;
  } finally {
    await release();
  }
}

export async function setStoredEntry(key: string, value: unknown): Promise<void> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  if (key.startsWith(PROJECT_EDIT_OWNERSHIP_PREFIX)
    || key.startsWith('agent-session-generation:')) {
    throw new Error('project store entry is server-managed');
  }
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const projectId = projectIdFromProjectStoreKey(key);
    if (projectId && deletedIds.has(projectId)) return;
    if (key === 'projects') {
      const current = await readEntryFile('projects');
      const safeCurrent = withoutDeletedProjects(
        { projects: current.found ? current.value : [] },
        deletedIds,
      ).projects;
      const safe = withoutDeletedProjects({ projects: value }, deletedIds).projects;
      const merged = mergeProjectIndex(safeCurrent, safe);
      const existing: unknown[] = [];
      for (const item of merged) {
        if (!isProjectStoreRecord(item) || typeof item.id !== 'string') continue;
        try {
          // SQLite mode: documents live in the kv table, not the JSON dir.
          const projectKey = `project:${item.id}`;
          const present = sqliteStoreEnabled()
            ? (await sqliteReadEntry(projectKey)).found
            : await access(entryPath(projectKey)).then(() => true);
          if (present) existing.push(item);
        } catch {
          // purgeProject deletes its document before updating the index.
        }
      }
      await writeStoredEntry(key, existing);
      return;
    }
    if (key.startsWith('agent-runtime:') || key.startsWith('agent-session-runtime:')
      || key.startsWith('agent-artifact:') || key.startsWith('agent-session-artifact:')) {
      const current = await readEntryFile(key);
      const sidecar = mergeAgentSidecar(key, current.value, value, current.found);
      if (sidecar.accepted) await writeStoredEntry(key, sidecar.value);
      return;
    }
    await writeStoredEntry(key, value);
  } finally {
    await release();
  }
}

async function purgeProjectEntryFilesDurably(projectId: string): Promise<void> {
  if (sqliteStoreEnabled()) {
    await sqliteDeleteProjectEntries(projectId);
    return;
  }
  for (const file of await readdir(STORE_DIR)) {
    if (!file.endsWith('.json')) continue;
    let key: string;
    try {
      key = decodeURIComponent(file.slice(0, -'.json'.length));
    } catch {
      await quarantineUnknownEntryFile(file);
      continue;
    }
    if (!isProjectStoreKey(key)) {
      await quarantineUnknownEntryFile(file);
      continue;
    }
    if (projectIdFromProjectStoreKey(key) === projectId) {
      await durableRemove(join(STORE_DIR, file));
    }
  }
}

async function purgeProjectLocked(id: string): Promise<void> {
  const deleted = await readDeletedProjects();
  await writeDeletedProjects({ ...deleted, [id]: Date.now() });
  await purgeProjectEntryFilesDurably(id);
  const current = await readEntryFile('projects');
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
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const projectId = PROJECT_DOCUMENT_KEY.exec(key)?.[1];
    if (projectId) {
      if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
      await purgeProjectLocked(projectId);
      removeStoreKey(`chat:${projectId}`);
      removeStoreKey(`project:${projectId}`);
    } else if (sqliteStoreEnabled()) {
      await sqliteDeleteEntry(key);
      removeStoreKey(key);
    } else {
      await durableRemove(entryPath(key));
    }
  } finally {
    await release();
  }
}

const { createLockedProjectStore, readEntryFile } = createProjectStoreEntryAdapter({
  entryPath,
  quarantineEntryFile,
  writeStoredEntry,
});

export async function getStoredEntry(key: string): Promise<StoredEntryValue> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const projectId = projectIdFromProjectStoreKey(key);
    if (projectId && Object.hasOwn(await readDeletedProjects(), projectId)) return { found: false };
    return await readEntryFile(key);
  } finally {
    await release();
  }
}


/**
 * Process-local serialization for project-store operations.
 *
 * The owner-safe cross-process file lease was removed (it caused "guard
 * busy" stalls and is unnecessary for a single-instance app). Within a single
 * process, multi-step store operations (project-document CAS, offline commits,
 * agent-runtime CAS, export-recovery) must still be mutually exclusive so their
 * read-modify-write steps do not interleave: e.g. a browser editor registered
 * while an offline commit is in flight must observe the post-commit revision
 * (reload) rather than claim a stale frame. This chained promise serializes
 * concurrent withProjectStoreLock callers in this process. Cross-process
 * safety on SQLite continues to come from WAL + busy_timeout.
 */
let projectStoreTail = Promise.resolve();
function serializeProjectStore<T>(task: () => Promise<T>): Promise<T> {
  const result = projectStoreTail.then(task, task);
  projectStoreTail = result.then(() => undefined, () => undefined);
  return result;
}

export async function withProjectStoreLock<T>(
  work: (store: LockedProjectStore) => Promise<T>,
): Promise<T> {
  return serializeProjectStore(async () => {
    await ensureStoreReady();
    try {
      const deletedIds = new Set(Object.keys(await readDeletedProjects()));
      return await work(createLockedProjectStore(deletedIds));
    } finally {
      // No per-operation release is needed: the promise chain above already
      // guarantees the next caller starts only after this one settles.
    }
  });
}

export const {
  compareAndSwapAgentRuntime,
  updateStoredAgentRunLease,
} = createAgentRuntimeStoreOperations(withProjectStoreLock);
const updateLegacyExportRecovery =
  createExportRecoveryLeaseOperation(withProjectStoreLock);

export async function updateExportRecoveryLease(
  input: ExportRecoveryLeaseInput,
): Promise<ProjectStoreMutationResponse> {
  await ensureStoreReady();
  if (!sqliteStoreEnabled()) return updateLegacyExportRecovery(input);
  const release = await acquireLock();
  try {
    return sqliteImmediateTransaction((store) => (
      executeImmediateExportRecoveryMutation(store, input)
    ));
  } finally {
    await release();
  }
}

export const compareAndSwapProjectDocument =
  createProjectDocumentStoreOperation(withProjectStoreLock);

export const rotateAgentSession = createAgentSessionStoreOperation(withProjectStoreLock);
