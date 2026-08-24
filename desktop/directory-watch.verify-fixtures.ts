import assert from 'node:assert/strict';
import type { DirectoryImportEvent } from '../shared/directory-import.ts';
import {
  DirectoryWatchSession,
  type DirectoryEntry,
  type DirectoryWatchDependencies,
} from './directory-watch.ts';
import type {
  DirectoryCandidateRequest,
  DirectoryCandidateResult,
  DirectoryFileFingerprint,
} from './directory-watch-import.ts';

export const ROOT = '/watch-root';
export const UPLOADS = '/media/uploads';
const FINGERPRINT: DirectoryFileFingerprint = { size: 10, mtimeMs: 20, ino: 30 };

export function entry(name: string, kind: 'file' | 'directory' | 'symlink' = 'file'): DirectoryEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function hashFor(name: string): string {
  const code = name.charCodeAt(0).toString(16).padStart(2, '0');
  return code.repeat(32);
}

export async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    const turn = Promise.withResolvers<void>();
    setTimeout(turn.resolve, 1);
    await turn.promise;
  }
  assert.equal(condition(), true);
}

export function imported(request: DirectoryCandidateRequest): DirectoryCandidateResult {
  if (request.knownFingerprint) {
    return { status: 'unchanged', fingerprint: request.knownFingerprint };
  }
  const storedName = `${request.name.replace(/\W/g, '-')}.mp4`;
  return {
    status: 'imported',
    prepared: {
      file: {
        name: request.name,
        src: `/media/uploads/${storedName}`,
        storedName,
        compatibilityNormalized: true,
        contentHash: hashFor(request.name),
        kind: 'video',
        size: FINGERPRINT.size,
        sourceModifiedAt: FINGERPRINT.mtimeMs,
      },
      fingerprint: FINGERPRINT,
      createdPaths: [`${UPLOADS}/${storedName}`],
    },
  };
}

export interface DirectoryWatchHarness {
  readonly tree: Map<string, DirectoryEntry[]>;
  readonly events: DirectoryImportEvent[];
  readonly removed: string[][];
  readonly dependencies: DirectoryWatchDependencies;
  fireWatch(): void;
  setDestination(path: string): void;
}

export function createHarness(
  importCandidate: (request: DirectoryCandidateRequest) => Promise<DirectoryCandidateResult>
    = async (request) => imported(request),
): DirectoryWatchHarness {
  const tree = new Map<string, DirectoryEntry[]>([[ROOT, []]]);
  const events: DirectoryImportEvent[] = [];
  const removed: string[][] = [];
  let listener: () => void = () => undefined;
  let destination = UPLOADS;
  return {
    tree,
    events,
    removed,
    dependencies: {
      readdir: async (path) => tree.get(path) ?? [],
      watch: (_path, nextListener) => {
        listener = nextListener;
        return { close: () => { listener = () => undefined; } };
      },
      realpath: async (path) => path,
      canonicalUploadDirectory: async () => destination,
      settleWrites: async () => undefined,
      importCandidate,
      removeFiles: async (paths) => { removed.push([...paths]); },
      randomId: (() => {
        let value = 0;
        return () => `import-${++value}`;
      })(),
    },
    fireWatch: () => listener(),
    setDestination: (path) => { destination = path; },
  };
}

export function sessionFor(harness: DirectoryWatchHarness, watchId: string): DirectoryWatchSession {
  return new DirectoryWatchSession({
    watchId,
    projectId: `project-${watchId}`,
    root: ROOT,
    pinnedUploadDirectory: UPLOADS,
    existingContentHashes: [],
    onImported: (event) => {
      harness.events.push(event);
      return true;
    },
  }, harness.dependencies);
}
