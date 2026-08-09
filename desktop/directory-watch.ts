import { randomUUID } from 'node:crypto';
import { watch as watchFileSystem, type Dirent, type FSWatcher } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  DirectoryImportDisposition,
  DirectoryImportedFile,
  DirectoryImportEvent,
  DirectoryWatchStartResult,
} from '../shared/directory-import.ts';
import {
  canonicalCurrentUploadDirectory,
  DirectoryDestinationChangedError,
  DirectoryImportCancelledError,
  importDirectoryCandidate,
  removeDirectoryImportFiles,
  type DirectoryCandidateRequest,
  type DirectoryCandidateResult,
  type DirectoryFileFingerprint,
  type PreparedDirectoryImport,
} from './directory-watch-import.ts';

export const DIRECTORY_SCAN_MAX_FILES = 400;
export const DIRECTORY_SCAN_MAX_DEPTH = 12;

type WatchPhase = 'created' | 'starting' | 'inactive' | 'active' | 'stopping' | 'stopped';

export interface DirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DirectoryWatchHandle {
  close(): void;
}

export interface DirectoryWatchDependencies {
  readonly readdir: (path: string) => Promise<readonly DirectoryEntry[]>;
  readonly watch: (path: string, listener: () => void) => DirectoryWatchHandle;
  readonly realpath: (path: string) => Promise<string>;
  readonly canonicalUploadDirectory: () => Promise<string>;
  readonly settleWrites: () => Promise<void>;
  readonly importCandidate: (request: DirectoryCandidateRequest) => Promise<DirectoryCandidateResult>;
  readonly removeFiles: (paths: readonly string[]) => Promise<void>;
  readonly randomId: () => string;
}

export interface DirectoryWatchSessionOptions {
  readonly watchId: string;
  readonly projectId: string;
  readonly root: string;
  readonly pinnedUploadDirectory: string;
  readonly existingContentHashes: readonly string[];
  readonly onImported: (event: DirectoryImportEvent) => boolean;
  readonly onFatalError?: (error: unknown) => void;
}

interface PendingPublication {
  readonly paths: readonly string[];
}

interface ScanCandidate {
  readonly path: string;
  readonly name: string;
}

export class DirectoryScanLimitError extends Error {
  readonly kind: 'files' | 'depth';
  readonly limit: number;

  constructor(kind: 'files' | 'depth', limit: number) {
    super(`directory scan exceeded the ${kind} limit (${limit})`);
    this.name = 'DirectoryScanLimitError';
    this.kind = kind;
    this.limit = limit;
  }
}

const DEFAULT_DEPENDENCIES: DirectoryWatchDependencies = {
  readdir: (path) => readdir(path, { withFileTypes: true }) as Promise<Dirent[]>,
  watch: (path, listener) => watchFileSystem(path, { recursive: true }, listener) as FSWatcher,
  realpath,
  canonicalUploadDirectory: canonicalCurrentUploadDirectory,
  settleWrites: () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    return promise;
  },
  importCandidate: (request) => importDirectoryCandidate(request),
  removeFiles: (paths) => removeDirectoryImportFiles(paths),
  randomId: randomUUID,
};

export async function scanImportDirectory(
  root: string,
  dependencies: Pick<DirectoryWatchDependencies, 'readdir'>,
  cancelled: () => boolean = () => false,
): Promise<readonly ScanCandidate[]> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const candidates: ScanCandidate[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    if (cancelled()) throw new DirectoryImportCancelledError();
    const current = queue[index];
    const entries = [...await dependencies.readdir(current.path)]
      .sort((left, right) => left.name.localeCompare(right.name));
    if (cancelled()) throw new DirectoryImportCancelledError();
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= DIRECTORY_SCAN_MAX_DEPTH) {
          throw new DirectoryScanLimitError('depth', DIRECTORY_SCAN_MAX_DEPTH);
        }
        queue.push({ path, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        candidates.push({ path, name: entry.name });
        if (candidates.length > DIRECTORY_SCAN_MAX_FILES) {
          throw new DirectoryScanLimitError('files', DIRECTORY_SCAN_MAX_FILES);
        }
      }
    }
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

export class DirectoryWatchSession {
  readonly watchId: string;
  readonly projectId: string;
  readonly directoryName: string;

  private readonly options: DirectoryWatchSessionOptions;
  private readonly dependencies: DirectoryWatchDependencies;
  private readonly hashes: Set<string>;
  private readonly known = new Map<string, DirectoryFileFingerprint>();
  private readonly pending = new Map<string, PendingPublication>();
  private readonly initialFiles: DirectoryImportedFile[] = [];
  private readonly abortController = new AbortController();
  private phase: WatchPhase = 'created';
  private watcher: DirectoryWatchHandle | null = null;
  private runner: Promise<void> | null = null;
  private dirty = false;
  private closeError: unknown;

  constructor(
    options: DirectoryWatchSessionOptions,
    dependencies: DirectoryWatchDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.options = options;
    this.dependencies = dependencies;
    this.watchId = options.watchId;
    this.projectId = options.projectId;
    this.directoryName = basename(options.root);
    this.hashes = new Set(options.existingContentHashes);
  }

  async start(): Promise<DirectoryWatchStartResult> {
    if (this.phase !== 'created') throw new Error('directory watch was already started');
    this.phase = 'starting';
    try {
      this.watcher = this.dependencies.watch(this.options.root, () => this.markDirty());
      await this.requestScan();
      if (this.cancelled()) throw new DirectoryImportCancelledError();
      this.phase = 'inactive';
      return {
        watchId: this.watchId,
        projectId: this.projectId,
        directoryName: this.directoryName,
        files: [...this.initialFiles],
      };
    } catch (error) {
      this.beginStop();
      await this.finishStop();
      throw error;
    }
  }

  async activate(): Promise<void> {
    if (this.phase === 'active') {
      await this.requestScan();
      return;
    }
    if (this.phase !== 'inactive') throw new Error('directory watch is not ready for activation');
    this.phase = 'active';
    try {
      await this.requestScan();
    } catch (error) {
      this.beginStop(error);
      await this.finishStop();
      throw error;
    }
  }

  async acknowledge(importId: string, disposition: DirectoryImportDisposition): Promise<void> {
    if (this.cancelled()) throw new Error('directory watch is stopped');
    const publication = this.pending.get(importId);
    if (!publication) throw new Error('directory import grant is unavailable');
    this.pending.delete(importId);
    if (disposition !== 'accepted') await this.dependencies.removeFiles(publication.paths);
  }

  async stop(): Promise<void> {
    this.beginStop();
    await this.finishStop();
    if (this.closeError) throw this.closeError;
  }

  private cancelled = (): boolean => this.phase === 'stopping' || this.phase === 'stopped';

  private markDirty(): void {
    if (this.cancelled()) return;
    this.dirty = true;
    if (this.phase === 'active') {
      void this.ensureRunner().catch((error) => this.handleBackgroundFailure(error));
    }
  }

  private requestScan(): Promise<void> {
    this.dirty = true;
    return this.ensureRunner();
  }

  private ensureRunner(): Promise<void> {
    if (!this.runner) this.runner = this.runOwnedLoop();
    return this.runner;
  }

  private async runOwnedLoop(): Promise<void> {
    try {
      while (this.dirty && !this.cancelled()) {
        this.dirty = false;
        await this.scanOnce();
      }
    } finally {
      this.runner = null;
      if (this.dirty && this.phase === 'active') {
        void this.ensureRunner().catch((error) => this.handleBackgroundFailure(error));
      }
    }
  }

  private async validateEnvironment(): Promise<void> {
    const [root, destination] = await Promise.all([
      this.dependencies.realpath(this.options.root),
      this.dependencies.canonicalUploadDirectory(),
    ]);
    if (this.cancelled()) throw new DirectoryImportCancelledError();
    if (root !== this.options.root || destination !== this.options.pinnedUploadDirectory) {
      throw new DirectoryDestinationChangedError();
    }
  }

  private async scanOnce(): Promise<void> {
    await this.validateEnvironment();
    const candidates = await scanImportDirectory(
      this.options.root, this.dependencies, this.cancelled,
    );
    if (candidates.length) {
      await this.dependencies.settleWrites();
      if (this.cancelled()) throw new DirectoryImportCancelledError();
    }
    const currentPaths = new Set(candidates.map((candidate) => candidate.path));
    for (const knownPath of this.known.keys()) {
      if (!currentPaths.has(knownPath)) this.known.delete(knownPath);
    }
    for (const candidate of candidates) {
      if (this.cancelled()) throw new DirectoryImportCancelledError();
      const result = await this.dependencies.importCandidate({
        sourcePath: candidate.path,
        root: this.options.root,
        name: candidate.name,
        pinnedUploadDirectory: this.options.pinnedUploadDirectory,
        knownFingerprint: this.known.get(candidate.path),
        knownHashes: this.hashes,
        cancelled: this.cancelled,
        signal: this.abortController.signal,
      });
      await this.consumeCandidate(candidate, result);
    }
  }

  private async consumeCandidate(
    candidate: ScanCandidate,
    result: DirectoryCandidateResult,
  ): Promise<void> {
    if (result.status === 'retry') {
      if (result.retryImmediately) this.dirty = true;
      return;
    }
    if (result.status === 'unchanged') return;
    if (result.status === 'unsupported' || result.status === 'duplicate') {
      this.known.set(candidate.path, result.fingerprint);
      return;
    }
    await this.publishCandidate(candidate, result.prepared);
  }

  private async publishCandidate(
    candidate: ScanCandidate,
    prepared: PreparedDirectoryImport,
  ): Promise<void> {
    if (this.cancelled()) {
      await this.dependencies.removeFiles(prepared.createdPaths);
      throw new DirectoryImportCancelledError();
    }
    const importId = this.dependencies.randomId();
    const file: DirectoryImportedFile = { importId, ...prepared.file };
    this.pending.set(importId, { paths: prepared.createdPaths });
    this.hashes.add(file.contentHash);
    this.known.set(candidate.path, prepared.fingerprint);
    if (this.phase === 'starting') {
      this.initialFiles.push(file);
      return;
    }
    if (this.phase !== 'active' || !this.options.onImported({
      watchId: this.watchId, projectId: this.projectId, file,
    })) {
      this.pending.delete(importId);
      await this.dependencies.removeFiles(prepared.createdPaths);
      this.beginStop();
      throw new DirectoryImportCancelledError();
    }
  }

  private beginStop(error?: unknown): void {
    if (this.cancelled()) return;
    this.phase = 'stopping';
    this.dirty = false;
    this.abortController.abort(new DirectoryImportCancelledError());
    try {
      this.watcher?.close();
    } catch (closeError) {
      this.closeError = closeError;
    }
    this.watcher = null;
    if (error !== undefined && this.closeError === undefined) this.closeError = error;
  }

  private async finishStop(): Promise<void> {
    await this.runner?.catch(() => undefined);
    const publications = [...this.pending.values()];
    this.pending.clear();
    const results = await Promise.allSettled(
      publications.map((publication) => this.dependencies.removeFiles(publication.paths)),
    );
    this.phase = 'stopped';
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures, 'failed to close directory watch');
  }

  private handleBackgroundFailure(error: unknown): void {
    this.beginStop(error);
    void this.finishStop().catch((stopError) => this.options.onFatalError?.(stopError));
    this.options.onFatalError?.(error);
  }
}
