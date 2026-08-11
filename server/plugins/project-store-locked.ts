import { readFile } from 'node:fs/promises';
import {
  isProjectStoreKey,
  projectIdFromProjectStoreKey,
} from '../../shared/project-store-validation.ts';
import { sqliteDeleteEntry, sqliteReadEntry, sqliteStoreEnabled } from '../storage/sqlite-store.ts';
import { mergeAgentSidecar } from './project-store-entries.ts';
import { durableRemove } from './project-store-durable.ts';

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

interface ProjectStoreEntryAdapterOptions {
  entryPath: (key: string) => string;
  quarantineEntryFile: (file: string, key: string) => Promise<unknown>;
  writeStoredEntry: (key: string, value: unknown) => Promise<void>;
}

export interface ProjectStoreEntryAdapter {
  readEntryFile: (key: string) => Promise<StoredEntryValue>;
  createLockedProjectStore: (deletedIds: ReadonlySet<string>) => LockedProjectStore;
}

export function createProjectStoreEntryAdapter(
  options: ProjectStoreEntryAdapterOptions,
): ProjectStoreEntryAdapter {
  async function readEntryFile(key: string): Promise<StoredEntryValue> {
    if (sqliteStoreEnabled()) return sqliteReadEntry(key);
    const file = `${encodeURIComponent(key)}.json`;
    try {
      const raw = await readFile(options.entryPath(key), 'utf8');
      try {
        return { found: true, value: JSON.parse(raw) };
      } catch {
        return { found: true, value: await options.quarantineEntryFile(file, key) };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
      throw error;
    }
  }

  function validateLockedEntryKey(key: string): string | undefined {
    if (!isProjectStoreKey(key)) throw new Error('invalid project store entry key');
    return projectIdFromProjectStoreKey(key);
  }

  function assertProjectNotDeleted(
    projectId: string | undefined,
    deletedIds: ReadonlySet<string>,
  ): void {
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
      if (sidecar.accepted) await options.writeStoredEntry(key, sidecar.value);
      return;
    }
    await options.writeStoredEntry(key, value);
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
    await options.writeStoredEntry(key, value);
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
    await options.writeStoredEntry(key, value);
  }

  function createLockedProjectStore(deletedIds: ReadonlySet<string>): LockedProjectStore {
    return {
      readEntry: (key) => readLockedEntry(key, deletedIds),
      writeEntry: (key, value) => writeLockedEntry(key, value, deletedIds),
      writeAgentRuntimeExact: (key, value) => writeAgentRuntimeExactLocked(key, value, deletedIds),
      writeEntryExact: (key, value) => writeEntryExactLocked(key, value, deletedIds),
      removeEntry: async (key) => {
        validateLockedEntryKey(key);
        if (sqliteStoreEnabled()) await sqliteDeleteEntry(key);
        else await durableRemove(options.entryPath(key));
      },
    };
  }

  return { readEntryFile, createLockedProjectStore };
}
