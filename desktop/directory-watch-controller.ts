import {
  DIRECTORY_IMPORT_CHANNELS,
  type DirectoryImportDisposition,
  type DirectoryImportEvent,
  type DirectoryWatchStartResult,
} from '../shared/directory-import.ts';
import { isPathInside } from './directory-watch-import.ts';
import type { DirectoryWatchSessionOptions } from './directory-watch.ts';

export interface DirectoryWatchSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface DirectoryWatchSessionContract {
  readonly watchId: string;
  readonly projectId: string;
  start(): Promise<DirectoryWatchStartResult>;
  activate(): Promise<void>;
  acknowledge(importId: string, disposition: DirectoryImportDisposition): Promise<void>;
  stop(): Promise<void>;
}

export interface DirectoryWatchControllerDependencies {
  readonly selectDirectory: (sender: DirectoryWatchSender) => Promise<string | null>;
  readonly realpath: (path: string) => Promise<string>;
  readonly canonicalUploadDirectory: () => Promise<string>;
  readonly randomId: () => string;
  readonly createSession: (options: DirectoryWatchSessionOptions) => DirectoryWatchSessionContract;
  readonly reportError: (error: unknown) => void;
}

interface OwnedWatch {
  readonly owner: DirectoryWatchSender;
  readonly projectId: string;
  readonly generation: number;
  readonly session: DirectoryWatchSessionContract;
}

export class DirectoryWatchController {
  private readonly dependencies: DirectoryWatchControllerDependencies;
  private readonly watches = new Map<string, OwnedWatch>();
  private readonly retiredWatches = new Map<string, OwnedWatch>();
  private readonly watchesByOwner = new Map<number, Set<string>>();
  private readonly generationsByOwner = new Map<number, Map<string, number>>();
  private readonly boundOwners = new Set<number>();

  constructor(dependencies: DirectoryWatchControllerDependencies) {
    this.dependencies = dependencies;
  }

  async start(
    owner: DirectoryWatchSender,
    projectId: string,
    existingContentHashes: readonly string[],
  ): Promise<DirectoryWatchStartResult | null> {
    this.assertOwnerAvailable(owner);
    const generation = this.invalidateProject(owner, projectId);
    await this.stopProjectWatches(owner, projectId);
    if (!this.isCurrent(owner, projectId, generation)) return null;

    const selected = await this.dependencies.selectDirectory(owner);
    if (!selected || !this.isCurrent(owner, projectId, generation)) return null;
    this.assertOwnerAvailable(owner);
    const [root, uploadDirectory] = await Promise.all([
      this.dependencies.realpath(selected),
      this.dependencies.canonicalUploadDirectory(),
    ]);
    if (!this.isCurrent(owner, projectId, generation)) return null;
    this.assertOwnerAvailable(owner);
    if (isPathInside(root, uploadDirectory) || isPathInside(uploadDirectory, root)) {
      throw new Error('the media destination cannot overlap the import directory');
    }
    const watchId = this.dependencies.randomId();
    const session = this.createOwnedSession(
      owner, watchId, projectId, root, uploadDirectory, existingContentHashes,
    );
    this.register(owner, projectId, generation, session);
    try {
      const result = await session.start();
      if (!this.isCurrent(owner, projectId, generation)
        || this.watches.get(watchId)?.session !== session) {
        await this.removeAndStop(watchId, session);
        return null;
      }
      return result;
    } catch (error) {
      await this.removeAndStop(watchId, session).catch((stopError) => {
        throw new AggregateError([error, stopError], 'directory watch failed to start');
      });
      if (!this.isCurrent(owner, projectId, generation)) return null;
      throw error;
    }
  }

  async activate(owner: DirectoryWatchSender, watchId: string): Promise<void> {
    const watch = this.ownedWatch(owner, watchId);
    await watch.session.activate();
    if (!this.isCurrent(owner, watch.projectId, watch.generation)
      || this.watches.get(watchId)?.session !== watch.session) {
      throw new Error('directory watch grant is unavailable');
    }
  }

  async acknowledge(
    owner: DirectoryWatchSender,
    watchId: string,
    importId: string,
    disposition: DirectoryImportDisposition,
  ): Promise<void> {
    await this.acknowledgementWatch(owner, watchId).session.acknowledge(importId, disposition);
  }

  async stop(owner: DirectoryWatchSender, watchId: string): Promise<void> {
    const watch = this.ownedWatch(owner, watchId);
    this.invalidateProject(owner, watch.projectId);
    await this.removeAndStop(watchId, watch.session);
  }

  async stopOwned(owner: DirectoryWatchSender): Promise<void> {
    const ids = [...(this.watchesByOwner.get(owner.id) ?? [])];
    for (const watchId of ids) {
      const watch = this.watches.get(watchId);
      if (watch?.owner === owner) this.invalidateProject(owner, watch.projectId);
    }
    const stops = ids.map(async (watchId) => {
      const watch = this.watches.get(watchId);
      if (watch?.owner === owner) await this.removeAndStop(watchId, watch.session);
    });
    const results = await Promise.allSettled(stops);
    this.boundOwners.delete(owner.id);
    this.generationsByOwner.delete(owner.id);
    const failures = results.filter((result) => result.status === 'rejected');
    for (const [watchId, watch] of this.retiredWatches) {
      if (watch.owner === owner) this.retiredWatches.delete(watchId);
    }
    if (failures.length) throw new AggregateError(failures, 'failed to close owned directory watches');
  }

  private createOwnedSession(
    owner: DirectoryWatchSender,
    watchId: string,
    projectId: string,
    root: string,
    uploadDirectory: string,
    existingContentHashes: readonly string[],
  ): DirectoryWatchSessionContract {
    return this.dependencies.createSession({
      watchId,
      projectId,
      root,
      pinnedUploadDirectory: uploadDirectory,
      existingContentHashes,
      onImported: (event) => this.publish(owner, event),
      onFileError: (error) => this.dependencies.reportError(error),
      onFatalError: (error) => {
        this.retireWatch(watchId);
        this.dependencies.reportError(error);
      },
    });
  }

  private register(
    owner: DirectoryWatchSender,
    projectId: string,
    generation: number,
    session: DirectoryWatchSessionContract,
  ): void {
    if (!this.isCurrent(owner, projectId, generation)) {
      throw new Error('directory watch generation is unavailable');
    }
    this.watches.set(session.watchId, { owner, projectId, generation, session });
    const owned = this.watchesByOwner.get(owner.id) ?? new Set<string>();
    owned.add(session.watchId);
    this.watchesByOwner.set(owner.id, owned);
    if (!this.boundOwners.has(owner.id)) {
      this.boundOwners.add(owner.id);
      owner.once('destroyed', () => {
        void this.stopOwned(owner).catch((error) => this.dependencies.reportError(error));
      });
    }
  }

  private publish(owner: DirectoryWatchSender, event: DirectoryImportEvent): boolean {
    const watch = this.watches.get(event.watchId);
    if (!watch || watch.owner !== owner || watch.projectId !== event.projectId
      || !this.isCurrent(owner, watch.projectId, watch.generation) || owner.isDestroyed()) {
      return false;
    }
    try {
      owner.send(DIRECTORY_IMPORT_CHANNELS.imported, event);
      return true;
    } catch {
      return false;
    }
  }

  private acknowledgementWatch(owner: DirectoryWatchSender, watchId: string): OwnedWatch {
    const watch = this.watches.get(watchId) ?? this.retiredWatches.get(watchId);
    if (!watch || watch.owner !== owner || owner.isDestroyed()) {
      throw new Error('directory watch grant is unavailable');
    }
    return watch;
  }

  private ownedWatch(owner: DirectoryWatchSender, watchId: string): OwnedWatch {
    const watch = this.watches.get(watchId);
    if (!watch || watch.owner !== owner || owner.isDestroyed()
      || !this.isCurrent(owner, watch.projectId, watch.generation)) {
      throw new Error('directory watch grant is unavailable');
    }
    return watch;
  }

  private async stopProjectWatches(
    owner: DirectoryWatchSender,
    projectId: string,
  ): Promise<void> {
    const ids = [...(this.watchesByOwner.get(owner.id) ?? [])];
    const stops = ids.flatMap((watchId) => {
      const watch = this.watches.get(watchId);
      return watch?.owner === owner && watch.projectId === projectId
        ? [this.removeAndStop(watchId, watch.session)]
        : [];
    });
    const results = await Promise.allSettled(stops);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, 'failed to reconfigure directory watch');
    }
  }

  private async removeAndStop(
    watchId: string,
    expectedSession: DirectoryWatchSessionContract,
  ): Promise<void> {
    const watch = this.watches.get(watchId);
    if (watch?.session === expectedSession) this.retireWatch(watchId);
    await expectedSession.stop();
  }

  private retireWatch(watchId: string): void {
    const watch = this.watches.get(watchId);
    if (!watch) return;
    this.retiredWatches.set(watchId, watch);
    this.forgetWatch(watchId);
  }

  private forgetWatch(watchId: string): void {
    const watch = this.watches.get(watchId);
    if (!watch) return;
    this.watches.delete(watchId);
    const owned = this.watchesByOwner.get(watch.owner.id);
    owned?.delete(watchId);
    if (owned?.size === 0) this.watchesByOwner.delete(watch.owner.id);
  }

  private invalidateProject(owner: DirectoryWatchSender, projectId: string): number {
    const generations = this.generationsByOwner.get(owner.id) ?? new Map<string, number>();
    const generation = (generations.get(projectId) ?? 0) + 1;
    generations.set(projectId, generation);
    this.generationsByOwner.set(owner.id, generations);
    return generation;
  }

  private isCurrent(
    owner: DirectoryWatchSender,
    projectId: string,
    generation: number,
  ): boolean {
    return !owner.isDestroyed()
      && this.generationsByOwner.get(owner.id)?.get(projectId) === generation;
  }

  private assertOwnerAvailable(owner: DirectoryWatchSender): void {
    if (owner.isDestroyed()) throw new Error('directory watch owner is unavailable');
  }
}
