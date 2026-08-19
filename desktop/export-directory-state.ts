import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

interface StoredExportDirectory {
  version: 2;
  currentDestinationId: string;
  destinations: Array<{ destinationId: string; path: string }>;
}

export interface ExportDirectoryState {
  currentPath: string | null;
  destinations: StoredExportDirectory['destinations'];
}

const DESKTOP_DESTINATION_ID = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_STORED_EXPORT_DESTINATIONS = 256;
const MAX_EXPORT_DESTINATION_STATE_BYTES = 512 * 1_024;
const INVALID_DESKTOP_EXPORT_FILENAME = /[/\\:*?"<>|]/;
const RESERVED_DESKTOP_EXPORT_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export async function validatedDirectory(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !isAbsolute(value)) return null;
  const path = await realpath(value).catch(() => null);
  if (!path) return null;
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ? path : null;
}

export function validDesktopExportFilename(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || value === '.' || value === '..' || basename(value) !== value) return false;
  if (new TextEncoder().encode(value).byteLength > 240
    || INVALID_DESKTOP_EXPORT_FILENAME.test(value)
    || /[. ]$/.test(value)
    || RESERVED_DESKTOP_EXPORT_FILENAME.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

async function readExportDirectoryState(statePath: string): Promise<ExportDirectoryState | null> {
  try {
    const info = await stat(statePath);
    if (!info.isFile() || info.size > MAX_EXPORT_DESTINATION_STATE_BYTES) {
      throw new Error('invalid export destination state');
    }
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    if (typeof stored !== 'object' || stored === null) throw new Error('invalid export destination');
    const version = 'version' in stored ? stored.version : undefined;
    if (version === 1) {
      const legacyPath = 'path' in stored ? stored.path : undefined;
      return { currentPath: typeof legacyPath === 'string' ? legacyPath : null, destinations: [] };
    }
    const currentDestinationId = 'currentDestinationId' in stored
      ? stored.currentDestinationId
      : undefined;
    const rawDestinations = 'destinations' in stored ? stored.destinations : undefined;
    if (version !== 2 || typeof currentDestinationId !== 'string' || !Array.isArray(rawDestinations)) {
      throw new Error('unsupported export destination version');
    }
    const destinations = rawDestinations.flatMap((entry): StoredExportDirectory['destinations'] => {
      if (!entry || typeof entry !== 'object') return [];
      const destinationId = 'destinationId' in entry ? entry.destinationId : undefined;
      const path = 'path' in entry ? entry.path : undefined;
      if (typeof destinationId !== 'string'
        || !DESKTOP_DESTINATION_ID.test(destinationId)
        || typeof path !== 'string'
        || !isAbsolute(path)) return [];
      return [{ destinationId, path }];
    }).slice(0, MAX_STORED_EXPORT_DESTINATIONS);
    const currentPath = destinations.find(
      (entry) => entry.destinationId === currentDestinationId,
    )?.path ?? null;
    return { currentPath, destinations };
  } catch {
    return null;
  }
}

export async function persistExportDirectory(
  statePath: string,
  path: string,
  destinationId: string,
  previousState?: ExportDirectoryState | null,
): Promise<void> {
  if (!DESKTOP_DESTINATION_ID.test(destinationId)) throw new Error('invalid export destination identity');
  const prior = previousState ?? await readExportDirectoryState(statePath);
  const destinations = [
    { destinationId, path },
    ...(prior?.destinations ?? []).filter((entry) => entry.destinationId !== destinationId),
  ].slice(0, MAX_STORED_EXPORT_DESTINATIONS);
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  const value: StoredExportDirectory = { version: 2, currentDestinationId: destinationId, destinations };
  await mkdir(dirname(statePath), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, statePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function restorePersistedExportDirectory(
  statePath: string,
): Promise<{ directory: string; state: ExportDirectoryState } | null> {
  const state = await readExportDirectoryState(statePath);
  if (!state?.currentPath) return null;
  const directory = await validatedDirectory(state.currentPath);
  return directory ? { directory, state } : null;
}

export async function resolvePersistedExportDestination(
  statePath: string,
  destinationId: string,
): Promise<string | null> {
  if (!DESKTOP_DESTINATION_ID.test(destinationId)) return null;
  const state = await readExportDirectoryState(statePath);
  const storedPath = state?.destinations.find((entry) => entry.destinationId === destinationId)?.path;
  return storedPath ? validatedDirectory(storedPath) : null;
}
