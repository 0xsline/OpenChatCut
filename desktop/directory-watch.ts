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
  readonly onFileError?: (error: unknown) => void;
}

interface Publication {
  readonly paths: readonly string[];
  readonly state: 'uncommitted' | 'reserved' | 'committed' | 'rejected';
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
  reportFileError: (error: unknown) => void = () => undefined,
): Promise<readonly ScanCandidate[]> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const candidates: ScanCandidate[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    if (cancelled()) throw new DirectoryImportCancelledError();
    const current = queue[index];
    let entries: readonly DirectoryEntry[];
    try {
      entries = await dependencies.readdir(current.path);
    } catch (error) {
      if (cancelled()) throw new DirectoryImportCancelledError();
      if (index === 0) throw error;
      reportFileError(error);
      continue;
    }
    if (cancelled()) throw new DirectoryImportCancelledError();
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
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
  private readonly publications = new Map<string, Publication>();
  private readonly initialFiles: DirectoryImportedFile[] = [];
  private phase: WatchPhase = 'created';
  private watcher: DirectoryWatchHandle | null = null;
  private runner: Promise<void> | null = null;
  private activeAbortController: AbortController | null = null;
  private generation = 0;
  private reconciledGeneration = -1;
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
      this.assertReady();
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
      this.assertReady();
      return;
    }
    if (this.phase !== 'inactive') throw new Error('directory watch is not ready for activation');
    this.phase = 'active';
    try {
      await this.requestScan();
      this.assertReady();
    } catch (error) {
      this.beginStop(error);
      await this.finishStop();
      throw error;
    }
  }

  async acknowledge(importId: string, disposition: DirectoryImportDisposition): Promise<void> {
    const publication = this.publications.get(importId);
    if (!publication) throw new Error('directory import grant is unavailable');
    if (disposition === 'reserved') {
      if (publication.state === 'rejected') throw new Error('directory import grant is unavailable');
      if (publication.state === 'uncommitted') {
        if (this.cancelled()) throw new Error('directory watch is stopped');
        this.publications.set(importId, { ...publication, state: 'reserved' });
      }
      return;
    }
    if (disposition === 'accepted') {
      if (publication.state === 'rejected') throw new Error('directory import grant is unavailable');
      if (publication.state === 'uncommitted') throw new Error('directory import publication is not reserved');
      if (publication.state === 'reserved') this.publications.set(importId, { ...publication, state: 'committed' });
      return;
    }
    if (publication.state === 'rejected') return;
    if (publication.state === 'committed') throw new Error('directory import publication is already committed');
    await this.dependencies.removeFiles(publication.paths);
    if (this.publications.get(importId) === publication) this.publications.set(importId, { ...publication, state: 'rejected' });
  }

  async stop(): Promise<void> {
    this.beginStop();
    await this.finishStop();
    if (this.closeError) throw this.closeError;
  }

  private cancelled = (): boolean => this.phase === 'stopping' || this.phase === 'stopped';

  private markDirty(): void {
    if (this.cancelled()) return;
    this.scheduleReconcile();
    if (this.phase === 'active') {
      void this.ensureRunner().catch((error) => this.handleBackgroundFailure(error));
    }
  }

  private async requestScan(): Promise<void> {
    const requestedGeneration = this.scheduleReconcile();
    while (!this.cancelled()) {
      await this.ensureRunner();
      if (this.reconciledGeneration === this.generation
        && this.reconciledGeneration >= requestedGeneration) return;
    }
    throw new DirectoryImportCancelledError();
  }

  private scheduleReconcile(): number {
    this.generation += 1;
    this.dirty = true;
    this.activeAbortController?.abort(new DirectoryImportCancelledError());
    return this.generation;
  }

  private ensureRunner(): Promise<void> {
    if (!this.runner) this.runner = this.runOwnedLoop();
    return this.runner;
  }

  private async runOwnedLoop(): Promise<void> {
    try {
      while (this.dirty && !this.cancelled()) {
        this.dirty = false;
        const generation = this.generation;
        const abortController = new AbortController();
        this.activeAbortController = abortController;
        try {
          const retryImmediately = await this.scanOnce(generation, abortController.signal);
          this.assertCurrent(generation, abortController.signal);
          this.reconciledGeneration = generation;
          if (retryImmediately) this.scheduleReconcile();
        } catch (error) {
          if (error instanceof DirectoryImportCancelledError
            && !this.cancelled() && generation !== this.generation) {
            continue;
          }
          throw error;
        } finally {
          if (this.activeAbortController === abortController) {
            this.activeAbortController = null;
          }
        }
      }
    } finally {
      this.runner = null;
      if (this.dirty && this.phase === 'active') {
        void this.ensureRunner().catch((error) => this.handleBackgroundFailure(error));
      }
    }
  }

  private async validateEnvironment(generation: number, signal: AbortSignal): Promise<void> {
    const [root, destination] = await Promise.all([
      this.dependencies.realpath(this.options.root),
      this.dependencies.canonicalUploadDirectory(),
    ]);
    this.assertCurrent(generation, signal);
    if (root !== this.options.root || destination !== this.options.pinnedUploadDirectory) {
      throw new DirectoryDestinationChangedError();
    }
  }

  private async scanOnce(generation: number, signal: AbortSignal): Promise<boolean> {
    const cancelled = (): boolean => !this.isCurrent(generation, signal);
    const staged: Array<{ candidate: ScanCandidate; prepared: PreparedDirectoryImport }> = [];
    try {
      await this.validateEnvironment(generation, signal);
      const candidates = await scanImportDirectory(
        this.options.root,
        this.dependencies,
        cancelled,
        (error) => this.reportFileError(error),
      );
      if (candidates.length) {
        await this.dependencies.settleWrites();
        this.assertCurrent(generation, signal);
      }

      const nextKnown = new Map(this.known);
      const nextHashes = new Set(this.hashes);
      const currentPaths = new Set(candidates.map((candidate) => candidate.path));
      for (const knownPath of nextKnown.keys()) {
        if (!currentPaths.has(knownPath)) nextKnown.delete(knownPath);
      }

      let retryImmediately = false;
      for (const candidate of candidates) {
        this.assertCurrent(generation, signal);
        let result: DirectoryCandidateResult;
        try {
          result = await this.dependencies.importCandidate({
            sourcePath: candidate.path,
            root: this.options.root,
            name: candidate.name,
            pinnedUploadDirectory: this.options.pinnedUploadDirectory,
            knownFingerprint: nextKnown.get(candidate.path),
            knownHashes: nextHashes,
            cancelled,
            signal,
            reportError: (error) => this.reportFileError(error),
          });
        } catch (error) {
          if (cancelled() || error instanceof DirectoryImportCancelledError) {
            throw new DirectoryImportCancelledError();
          }
          if (this.isPerFileError(error)) {
            this.reportFileError(error);
            continue;
          }
          throw error;
        }
        if (result.status === 'imported') {
          staged.push({ candidate, prepared: result.prepared });
        }
        this.assertCurrent(generation, signal);
        if (result.status === 'retry') {
          retryImmediately ||= result.retryImmediately;
        } else if (result.status === 'unsupported' || result.status === 'duplicate') {
          nextKnown.set(candidate.path, result.fingerprint);
        } else if (result.status === 'imported') {
          nextKnown.set(candidate.path, result.prepared.fingerprint);
          if (result.prepared.file.contentHash) nextHashes.add(result.prepared.file.contentHash);
        }
      }

      this.assertCurrent(generation, signal);
      this.known.clear();
      for (const [path, fingerprint] of nextKnown) this.known.set(path, fingerprint);
      this.hashes.clear();
      for (const hash of nextHashes) this.hashes.add(hash);

      while (staged.length) {
        const publication = staged.shift();
        if (!publication) break;
        await this.publishCandidate(
          generation, signal, publication.candidate, publication.prepared,
        );
      }
      this.assertCurrent(generation, signal);
      return retryImmediately;
    } catch (error) {
      if (staged.length) {
        const cleanups = staged.map(({ prepared }) =>
          this.dependencies.removeFiles(prepared.createdPaths));
        const results = await Promise.allSettled(cleanups);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length) {
          throw new AggregateError([error, ...failures], 'directory reconcile cleanup failed');
        }
      }
      throw error;
    }
  }

  private async publishCandidate(
    generation: number,
    signal: AbortSignal,
    candidate: ScanCandidate,
    prepared: PreparedDirectoryImport,
  ): Promise<void> {
    if (!this.isCurrent(generation, signal)) {
      await this.dependencies.removeFiles(prepared.createdPaths);
      throw new DirectoryImportCancelledError();
    }
    const importId = this.dependencies.randomId();
    const file: DirectoryImportedFile = { importId, ...prepared.file };
    this.publications.set(importId, { paths: prepared.createdPaths, state: 'uncommitted' });
    if (file.contentHash) this.hashes.add(file.contentHash);
    this.known.set(candidate.path, prepared.fingerprint);
    if (this.phase === 'starting') {
      this.initialFiles.push(file);
      return;
    }
    if (!this.isCurrent(generation, signal) || this.phase !== 'active'
      || !this.options.onImported({
        watchId: this.watchId, projectId: this.projectId, file,
      })) {
      this.publications.delete(importId);
      await this.dependencies.removeFiles(prepared.createdPaths);
      this.beginStop();
      throw new DirectoryImportCancelledError();
    }
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return !this.cancelled() && generation === this.generation && !signal.aborted;
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (!this.isCurrent(generation, signal)) throw new DirectoryImportCancelledError();
  }

  private assertReady(): void {
    if (this.cancelled() || this.reconciledGeneration !== this.generation) {
      throw new DirectoryImportCancelledError();
    }
  }

  private isPerFileError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES'
      || code === 'EPERM' || code === 'ESTALE';
  }

  private reportFileError(error: unknown): void {
    try {
      this.options.onFileError?.(error);
    } catch {
      // Error reporting must not turn an isolated candidate failure into a watch failure.
    }
  }

  private beginStop(error?: unknown): void {
    if (this.cancelled()) return;
    this.phase = 'stopping';
    this.generation += 1;
    this.dirty = false;
    this.activeAbortController?.abort(new DirectoryImportCancelledError());
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
    const abandoned = [...this.publications.entries()]
      .filter(([, publication]) => publication.state === 'uncommitted');
    const results = await Promise.allSettled(
      abandoned.map(async ([importId, publication]) => {
        await this.dependencies.removeFiles(publication.paths);
        if (this.publications.get(importId) === publication) this.publications.set(importId, { ...publication, state: 'rejected' });
      }),
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
