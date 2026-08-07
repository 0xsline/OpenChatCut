import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { isProjectStoreEntries, isProjectStoreKey } from '../../shared/project-store-validation.ts';
import {
  exchangeProjectStoreLaunchToken,
  projectStoreHttpAuthorized,
} from '../project-store-http-auth.ts';
import { handleProjectStoreRequest, sendProjectStoreJson } from '../project-store-http.ts';

const ROOT_DIR = join(homedir(), '.openchatcut');
const LEGACY_STORE_PATH = join(ROOT_DIR, 'project-store-v1.json');
const LEGACY_BACKUP_PATH = `${LEGACY_STORE_PATH}.migrated`;
const STORE_DIR = join(ROOT_DIR, 'project-store-v1');
const READY_PATH = join(STORE_DIR, '.ready');
const LOCK_PATH = join(ROOT_DIR, 'project-store-v1.lock');
const DELETED_PROJECTS_PATH = join(ROOT_DIR, 'deleted-projects-v1.json');
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 200;
const PROJECT_SCOPED_KEY = /^(?:project|chat|creative-mode|thumb|proposal|versions|jobs):(.+)$/;
const PROJECT_DOCUMENT_KEY = /^project:(.+)$/;
const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;

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
  removeEntry: (key: string) => Promise<void>;
}
interface ProjectMeta {
  id: string;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const validEntries = isProjectStoreEntries;

function projectMetas(entries: Record<string, unknown>): Map<string, ProjectMeta> {
  const value = entries.projects;
  const metas = Array.isArray(value) ? value : [];
  return new Map(metas.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.updatedAt !== 'number') return [];
    return [[item.id, { id: item.id, updatedAt: item.updatedAt }]];
  }));
}

function itemIdentity(value: unknown): string {
  if (isRecord(value)) {
    for (const key of ['id', 'jobId', 'name']) {
      if (typeof value[key] === 'string') return `${key}:${value[key]}`;
    }
  }
  return `json:${JSON.stringify(value)}`;
}

function itemTime(value: unknown): number {
  if (!isRecord(value)) return 0;
  for (const key of ['updatedAt', 'createdAt']) {
    if (typeof value[key] === 'number') return value[key];
  }
  return 0;
}

function mergeArrays(base: unknown[], incoming: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  for (const item of [...base, ...incoming]) {
    const identity = itemIdentity(item);
    const previous = merged.get(identity);
    if (previous === undefined || itemTime(item) >= itemTime(previous)) merged.set(identity, item);
  }
  return [...merged.values()];
}

function mergeProjectIndex(base: unknown, incoming: unknown): unknown[] {
  const left = Array.isArray(base) ? base : [];
  const right = Array.isArray(incoming) ? incoming : [];
  return mergeArrays(left, right).sort((a, b) => itemTime(b) - itemTime(a));
}

function withoutDeletedProjects(
  entries: Record<string, unknown>,
  deletedIds: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key === 'projects') {
      result[key] = (Array.isArray(value) ? value : []).filter(
        (item) => !isRecord(item) || typeof item.id !== 'string' || !deletedIds.has(item.id),
      );
      continue;
    }
    const projectId = PROJECT_SCOPED_KEY.exec(key)?.[1];
    if (!projectId || !deletedIds.has(projectId)) result[key] = value;
  }
  return result;
}

function shouldMergeArray(key: string, base: unknown, incoming: unknown): boolean {
  if (!Array.isArray(base) || !Array.isArray(incoming)) return false;
  return key === 'export:history'
    || key === 'design-styles:owned'
    || key === 'skills:custom'
    || key === 'templates:all'
    || key.startsWith('versions:')
    || key.startsWith('jobs:');
}

/** First-open migration merges every browser's unique projects without discarding either side. */
export function mergeProjectEntries(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  deletedIds: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const safeBase = withoutDeletedProjects(base, deletedIds);
  const safeIncoming = withoutDeletedProjects(incoming, deletedIds);
  const result = { ...safeBase };
  const baseMetas = projectMetas(safeBase);
  const incomingMetas = projectMetas(safeIncoming);
  for (const [key, value] of Object.entries(safeIncoming)) {
    if (key === 'projects') {
      result[key] = mergeProjectIndex(safeBase[key], value);
      continue;
    }
    if (!(key in safeBase)) {
      result[key] = value;
      continue;
    }
    if (shouldMergeArray(key, safeBase[key], value)) {
      result[key] = mergeArrays(safeBase[key] as unknown[], value as unknown[]);
      continue;
    }
    const projectId = PROJECT_SCOPED_KEY.exec(key)?.[1];
    if (!projectId || (incomingMetas.get(projectId)?.updatedAt ?? 0) > (baseMetas.get(projectId)?.updatedAt ?? 0)) {
      result[key] = value;
    }
  }
  return result;
}

async function readLegacyStore(): Promise<{ exists: boolean; store: StoreFile }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(LEGACY_STORE_PATH, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1 || !validEntries(parsed.entries)) {
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
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('project store value is not JSON serializable');
  const target = entryPath(key);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, encoded, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
}

async function readDeletedProjects(): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(DELETED_PROJECTS_PATH, 'utf8'));
    if (!isRecord(parsed)) throw new Error('invalid deleted project registry');
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
  const temp = `${DELETED_PROJECTS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(projects), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, DELETED_PROJECTS_PATH);
}

async function writeEntries(entries: Record<string, unknown>): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
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
    const key = decodeURIComponent(file.slice(0, -'.json'.length));
    if (!isProjectStoreKey(key)) throw new Error('invalid project store entry filename');
    entries[key] = JSON.parse(await readFile(join(STORE_DIR, file), 'utf8'));
  }
  return entries;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function removeStaleLock(): Promise<void> {
  try {
    if (Date.now() - (await stat(LOCK_PATH)).mtimeMs > LOCK_STALE_MS) await rm(LOCK_PATH, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(ROOT_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const handle = await open(LOCK_PATH, 'wx', 0o600);
      return async () => {
        await handle.close();
        await rm(LOCK_PATH, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await removeStaleLock();
      await delay(10);
    }
  }
  throw new Error('project store is busy');
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
  await writeFile(READY_PATH, '1\n', { encoding: 'utf8', mode: 0o600 });
  if (!legacy.exists) return;
  await rm(LEGACY_BACKUP_PATH, { force: true });
  await rename(LEGACY_STORE_PATH, LEGACY_BACKUP_PATH);
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
  const deletedIds = new Set(Object.keys(await readDeletedProjects()));
  const entries = withoutDeletedProjects(await readDirectoryEntries(), deletedIds);
  if (!validEntries(entries)) throw new Error('invalid project store entries');
  return { version: 1, entries };
}

export async function mergeStoredEntries(incoming: Record<string, unknown>): Promise<StoreFile> {
  if (!isProjectStoreEntries(incoming)) throw new Error('invalid project store entries');
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const next: StoreFile = {
      version: 1,
      entries: mergeProjectEntries(await readDirectoryEntries(), incoming, deletedIds),
    };
    await writeEntries(next.entries);
    return next;
  } finally {
    await release();
  }
}

export async function setStoredEntry(key: string, value: unknown): Promise<void> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const projectId = PROJECT_SCOPED_KEY.exec(key)?.[1];
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
        if (!isRecord(item) || typeof item.id !== 'string') continue;
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
    await writeStoredEntry(key, value);
  } finally {
    await release();
  }
}

async function purgeProjectLocked(id: string): Promise<void> {
  const deleted = await readDeletedProjects();
  await writeDeletedProjects({ ...deleted, [id]: Date.now() });
  for (const file of await readdir(STORE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const key = decodeURIComponent(file.slice(0, -'.json'.length));
    if (PROJECT_SCOPED_KEY.exec(key)?.[1] === id) await rm(join(STORE_DIR, file), { force: true });
  }
  const current = await readEntryFile('projects');
  const projects = Array.isArray(current.value)
    ? current.value.filter((item) => !isRecord(item) || item.id !== id)
    : [];
  await writeStoredEntry('projects', projects);
}

export async function deleteStoredEntry(key: string): Promise<void> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const projectId = PROJECT_DOCUMENT_KEY.exec(key)?.[1];
    if (projectId) {
      if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
      await purgeProjectLocked(projectId);
    } else {
      await rm(entryPath(key), { force: true });
    }
  } finally {
    await release();
  }
}

async function readEntryFile(key: string): Promise<StoredEntryValue> {
  try {
    return { found: true, value: JSON.parse(await readFile(entryPath(key), 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
    throw error;
  }
}

export async function getStoredEntry(key: string): Promise<StoredEntryValue> {
  if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
  await ensureStoreReady();
  const projectId = PROJECT_SCOPED_KEY.exec(key)?.[1];
  if (projectId && Object.hasOwn(await readDeletedProjects(), projectId)) return { found: false };
  return readEntryFile(key);
}

export async function withProjectStoreLock<T>(
  work: (store: LockedProjectStore) => Promise<T>,
): Promise<T> {
  await ensureStoreReady();
  const release = await acquireLock();
  try {
    const deletedIds = new Set(Object.keys(await readDeletedProjects()));
    const validateKey = (key: string): string | undefined => {
      if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
      return PROJECT_SCOPED_KEY.exec(key)?.[1];
    };
    return await work({
      readEntry: async (key) => {
        const projectId = validateKey(key);
        return projectId && deletedIds.has(projectId) ? { found: false } : readEntryFile(key);
      },
      writeEntry: async (key, value) => {
        const projectId = validateKey(key);
        if (projectId && deletedIds.has(projectId)) throw new Error('project was deleted');
        await writeStoredEntry(key, value);
      },
      removeEntry: async (key) => {
        validateKey(key);
        await rm(entryPath(key), { force: true });
      },
    });
  } finally {
    await release();
  }
}


const HTTP_OPERATIONS = {
  deleteEntry: deleteStoredEntry,
  getEntry: getStoredEntry,
  mergeEntries: mergeStoredEntries,
  readSnapshot: readStore,
  setEntry: setStoredEntry,
};

export function projectStorePlugin(options: { http?: boolean } = {}): Plugin {
  return {
    name: 'openchatcut-project-store',
    configureServer(server) {
      if (options.http === false) return;
      server.middlewares.use('/api/project-store', async (req, res) => {
        if (req.method === 'POST' && req.url === '/session') {
          const session = exchangeProjectStoreLaunchToken(req);
          sendProjectStoreJson(
            res,
            session ? 200 : 403,
            session ?? { error: 'invalid or expired editor launch credential' },
          );
          return;
        }
        if (!projectStoreHttpAuthorized(req)) {
          sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
          return;
        }
        try {
          await handleProjectStoreRequest(req, res, HTTP_OPERATIONS);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[project-store] ${message}`);
          if (!res.headersSent) sendProjectStoreJson(res, 400, { error: message });
        }
      });
    },
  };
}
