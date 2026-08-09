import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isProjectStoreEntries,
  isProjectStoreKey,
  isProjectStoreRecord,
  projectIdFromProjectStoreKey,
} from '../../shared/project-store-validation.ts';
import {
  mergeAgentSidecar,
  mergeProjectEntries,
  mergeProjectIndex,
  withoutDeletedProjects,
} from './project-store-entries.ts';
import { createAgentRuntimeStoreOperations } from './project-store-agent-runtime.ts';
import {
  assertAgentSessionMigrationSafe,
  createAgentSessionStoreOperation,
  prepareAgentSessionMigrationEntries,
} from './project-store-agent-session.ts';
import { createProjectDocumentStoreOperation } from './project-store-project-document.ts';
import {
  atomicWriteFile,
  atomicWriteJson,
  createOwnerSafeLeaseLock,
  durableMkdir,
  durableRemove,
  durableRename,
} from './project-store-durable.ts';

const ROOT_DIR = join(homedir(), '.openchatcut');
const LEGACY_STORE_PATH = join(ROOT_DIR, 'project-store-v1.json');
const LEGACY_BACKUP_PATH = `${LEGACY_STORE_PATH}.migrated`;
const STORE_DIR = join(ROOT_DIR, 'project-store-v1');
const QUARANTINE_DIR = join(STORE_DIR, '.quarantine');
const READY_PATH = join(STORE_DIR, '.ready');
const LOCK_PATH = join(ROOT_DIR, 'project-store-v1.lock');
const DELETED_PROJECTS_PATH = join(ROOT_DIR, 'deleted-projects-v1.json');
const LOCK_STALE_MS = 10_000;
const PROJECT_DOCUMENT_KEY = /^project:(.+)$/;
const PROJECT_EDIT_OWNERSHIP_PREFIX = 'project-edit-ownership:';
const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const STORE_LOCK = createOwnerSafeLeaseLock({
  path: LOCK_PATH,
  leaseMs: LOCK_STALE_MS,
  heartbeatMs: 2_500,
  retries: 200,
  retryMs: 10,
});

interface StoreFile {
  version: 1;
  entries: Record<string, unknown>;
}

export interface StoredEntryValue {
  found: boolean;
  value?: unknown;
}

export interface LockedProjectStore {
  readEntry: (key: string) => Promise<StoredEntryValue>;
  writeEntry: (key: string, value: unknown) => Promise<void>;
  writeAgentRuntimeExact: (key: string, value: unknown) => Promise<void>;
  writeEntryExact: (key: string, value: unknown) => Promise<void>;
  removeEntry: (key: string) => Promise<void>;
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

const entryPath = (key: string) => join(STORE_DIR, `${encodeURIComponent(key)}.json`);

async function writeStoredEntry(key: string, value: unknown): Promise<void> {
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
  await atomicWriteJson(DELETED_PROJECTS_PATH, projects);
}

async function writeEntries(entries: Record<string, unknown>): Promise<void> {
  await durableMkdir(STORE_DIR, true);
  const ordered = Object.entries(entries).sort(([left], [right]) => {
    if (left === 'projects') return 1;
    if (right === 'projects') return -1;
    return left.localeCompare(right);
  });
  for (const [key, value] of ordered) await writeStoredEntry(key, value);
}

async function readDirectoryEntries(): Promise<Record<string, unknown>> {
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
  return (await STORE_LOCK.acquire()).release;
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
          await access(entryPath(`project:${item.id}`));
          existing.push(item);
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
    } else {
      await durableRemove(entryPath(key));
    }
  } finally {
    await release();
  }
}

async function readEntryFile(key: string): Promise<StoredEntryValue> {
  const file = `${encodeURIComponent(key)}.json`;
  try {
    const raw = await readFile(entryPath(key), 'utf8');
    try {
      return { found: true, value: JSON.parse(raw) };
    } catch {
      return { found: true, value: await quarantineEntryFile(file, key) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
    throw error;
  }
}

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

function validateLockedEntryKey(key: string): string | undefined {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  return projectIdFromProjectStoreKey(key);
}

function assertProjectNotDeleted(projectId: string | undefined, deletedIds: ReadonlySet<string>): void {
  if (projectId && deletedIds.has(projectId)) throw new Error('project was deleted');
}

async function readLockedEntry(
  key: string,
  deletedIds: ReadonlySet<string>,
): Promise<StoredEntryValue> {
  const projectId = validateLockedEntryKey(key);
  return projectId && deletedIds.has(projectId) ? { found: false } : readEntryFile(key);
}

async function writeLockedEntry(
  key: string,
  value: unknown,
  deletedIds: ReadonlySet<string>,
): Promise<void> {
  assertProjectNotDeleted(validateLockedEntryKey(key), deletedIds);
  if (key.startsWith('agent-runtime:') || key.startsWith('agent-session-runtime:')
    || key.startsWith('agent-artifact:') || key.startsWith('agent-session-artifact:')) {
    const current = await readEntryFile(key);
    const sidecar = mergeAgentSidecar(key, current.value, value, current.found);
    if (sidecar.accepted) await writeStoredEntry(key, sidecar.value);
    return;
  }
  await writeStoredEntry(key, value);
}

async function writeAgentRuntimeExactLocked(
  key: string,
  value: unknown,
  deletedIds: ReadonlySet<string>,
): Promise<void> {
  const projectId = validateLockedEntryKey(key);
  if (!key.startsWith('agent-runtime:') && !key.startsWith('agent-session-runtime:')) {
    throw new Error('exact write is limited to agent runtime');
  }
  assertProjectNotDeleted(projectId, deletedIds);
  await writeStoredEntry(key, value);
}

async function writeEntryExactLocked(
  key: string,
  value: unknown,
  deletedIds: ReadonlySet<string>,
): Promise<void> {
  const projectId = validateLockedEntryKey(key);
  if (!key.startsWith('project:') && !key.startsWith('project-edit-ownership:')) {
    throw new Error('exact write is limited to project document CAS');
  }
  assertProjectNotDeleted(projectId, deletedIds);
  await writeStoredEntry(key, value);
}

function createLockedProjectStore(deletedIds: ReadonlySet<string>): LockedProjectStore {
  return {
    readEntry: (key) => readLockedEntry(key, deletedIds),
    writeEntry: (key, value) => writeLockedEntry(key, value, deletedIds),
    writeAgentRuntimeExact: (key, value) => writeAgentRuntimeExactLocked(key, value, deletedIds),
    writeEntryExact: (key, value) => writeEntryExactLocked(key, value, deletedIds),
    removeEntry: async (key) => {
      validateLockedEntryKey(key);
      await durableRemove(entryPath(key));
    },
  };
}

export async function withProjectStoreLock<T>(
  work: (store: LockedProjectStore) => Promise<T>,
): Promise<T> {
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    return await work(createLockedProjectStore(deletedIds));
  } finally {
    await release();
  }
}

export const {
  compareAndSwapAgentRuntime,
  updateStoredAgentRunLease,
} = createAgentRuntimeStoreOperations(withProjectStoreLock);

export const compareAndSwapProjectDocument =
  createProjectDocumentStoreOperation(withProjectStoreLock);

export const rotateAgentSession = createAgentSessionStoreOperation(withProjectStoreLock);
