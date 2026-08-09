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
  readonly session: DirectoryWatchSessionContract;
}

export class DirectoryWatchController {
  private readonly dependencies: DirectoryWatchControllerDependencies;
  private readonly watches = new Map<string, OwnedWatch>();
  private readonly watchesByOwner = new Map<number, Set<string>>();
  private readonly boundOwners = new Set<number>();

  constructor(dependencies: DirectoryWatchControllerDependencies) {
    this.dependencies = dependencies;
  }

  async start(
    owner: DirectoryWatchSender,
    projectId: string,
    existingContentHashes: readonly string[],
  ): Promise<DirectoryWatchStartResult | null> {
    const selected = await this.dependencies.selectDirectory(owner);
    if (!selected) return null;
    this.assertOwnerAvailable(owner);
    const [root, uploadDirectory] = await Promise.all([
      this.dependencies.realpath(selected),
      this.dependencies.canonicalUploadDirectory(),
    ]);
    this.assertOwnerAvailable(owner);
    if (isPathInside(root, uploadDirectory) || isPathInside(uploadDirectory, root)) {
      throw new Error('the media destination cannot overlap the import directory');
    }
    const watchId = this.dependencies.randomId();
    const session = this.createOwnedSession(
      owner, watchId, projectId, root, uploadDirectory, existingContentHashes,
    );
    this.register(owner, projectId, session);
    try {
      const result = await session.start();
      if (this.watches.get(watchId)?.session !== session) {
        throw new Error('directory watch owner is unavailable');
      }
      return result;
    } catch (error) {
      await this.removeAndStop(watchId, session).catch((stopError) => {
        throw new AggregateError([error, stopError], 'directory watch failed to start');
      });
      throw error;
    }
  }

  async activate(owner: DirectoryWatchSender, watchId: string): Promise<void> {
    await this.ownedWatch(owner, watchId).session.activate();
  }

  async acknowledge(
    owner: DirectoryWatchSender,
    watchId: string,
    importId: string,
    disposition: DirectoryImportDisposition,
  ): Promise<void> {
    await this.ownedWatch(owner, watchId).session.acknowledge(importId, disposition);
  }

  async stop(owner: DirectoryWatchSender, watchId: string): Promise<void> {
    const watch = this.ownedWatch(owner, watchId);
    await this.removeAndStop(watchId, watch.session);
  }

  async stopOwned(owner: DirectoryWatchSender): Promise<void> {
    const ids = [...(this.watchesByOwner.get(owner.id) ?? [])];
    const stops = ids.map(async (watchId) => {
      const watch = this.watches.get(watchId);
      if (watch?.owner === owner) await this.removeAndStop(watchId, watch.session);
    });
    const results = await Promise.allSettled(stops);
    this.boundOwners.delete(owner.id);
    const failures = results.filter((result) => result.status === 'rejected');
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
      onFatalError: (error) => {
        this.forgetWatch(watchId);
        this.dependencies.reportError(error);
      },
    });
  }

  private register(
    owner: DirectoryWatchSender,
    projectId: string,
    session: DirectoryWatchSessionContract,
  ): void {
    this.watches.set(session.watchId, { owner, projectId, session });
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
    if (!watch || watch.owner !== owner || watch.projectId !== event.projectId || owner.isDestroyed()) {
      return false;
    }
    try {
      owner.send(DIRECTORY_IMPORT_CHANNELS.imported, event);
      return true;
    } catch {
      return false;
    }
  }

  private ownedWatch(owner: DirectoryWatchSender, watchId: string): OwnedWatch {
    const watch = this.watches.get(watchId);
    if (!watch || watch.owner !== owner || owner.isDestroyed()) {
      throw new Error('directory watch grant is unavailable');
    }
    return watch;
  }

  private async removeAndStop(
    watchId: string,
    expectedSession: DirectoryWatchSessionContract,
  ): Promise<void> {
    const watch = this.watches.get(watchId);
    if (watch?.session === expectedSession) this.forgetWatch(watchId);
    await expectedSession.stop();
  }

  private forgetWatch(watchId: string): void {
    const watch = this.watches.get(watchId);
    if (!watch) return;
    this.watches.delete(watchId);
    const owned = this.watchesByOwner.get(watch.owner.id);
    owned?.delete(watchId);
    if (owned?.size === 0) this.watchesByOwner.delete(watch.owner.id);
  }

  private assertOwnerAvailable(owner: DirectoryWatchSender): void {
    if (owner.isDestroyed()) throw new Error('directory watch owner is unavailable');
  }
}
