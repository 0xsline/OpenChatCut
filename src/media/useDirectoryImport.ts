import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DirectoryImportedFile,
  DirectoryImportDisposition,
  DirectoryImportEvent,
  DirectoryWatchStartResult,
} from '../../shared/directory-import';
import { normalizeSha256Hash } from '../../shared/content-hash';
import type { MediaAsset } from '../editor/types';
import type { t as translate } from '../i18n/locale';
import { directoryFileToAsset } from './directoryImportAsset';

export interface DirectoryImportDesktopApi {
  startImportDirectoryWatch(
    projectId: string,
    existingContentHashes: readonly string[],
  ): Promise<DirectoryWatchStartResult | null>;
  activateImportDirectoryWatch(watchId: string): Promise<void>;
  acknowledgeImportDirectoryFile(
    watchId: string,
    importId: string,
    disposition: DirectoryImportDisposition,
  ): Promise<void>;
  stopImportDirectoryWatch(watchId: string): Promise<void>;
  subscribeImportDirectory(listener: (event: DirectoryImportEvent) => void): () => void;
}

export interface ActiveDirectoryWatch {
  readonly watchId: string;
  readonly directoryName: string;
}

interface RuntimeSession extends ActiveDirectoryWatch {
  readonly projectId: string;
  readonly acceptedHashes: Set<string>;
  cancelled: boolean;
  queue: Promise<void>;
}

export interface DirectoryImportRuntimeOptions {
  api: DirectoryImportDesktopApi;
  getProjectId: () => string;
  getFps: () => number;
  getAssets: () => readonly MediaAsset[];
  ingest: (asset: MediaAsset) => void;
  convert?: typeof directoryFileToAsset;
  onWatchChange: (watch: ActiveDirectoryWatch | null) => void;
  onBusyChange: (busy: boolean) => void;
  onError: (reason: unknown) => void;
}

function currentContentHashes(assets: readonly MediaAsset[]): string[] {
  const hashes = new Set<string>();
  for (const asset of assets) {
    const hash = normalizeSha256Hash(asset.sourceContentHash);
    if (hash) hashes.add(hash);
  }
  return [...hashes];
}

export class DirectoryImportRuntime {
  readonly #options: DirectoryImportRuntimeOptions;
  #session: RuntimeSession | null = null;
  #startVersion = 0;

  constructor(options: DirectoryImportRuntimeOptions) {
    this.#options = options;
  }

  get activeWatch(): ActiveDirectoryWatch | null {
    const session = this.#session;
    return session ? { watchId: session.watchId, directoryName: session.directoryName } : null;
  }

  async start(): Promise<ActiveDirectoryWatch | null> {
    await this.stop();
    const version = ++this.#startVersion;
    const projectId = this.#options.getProjectId();
    this.#options.onBusyChange(true);
    try {
      const hashes = currentContentHashes(this.#options.getAssets());
      const result = await this.#options.api.startImportDirectoryWatch(projectId, hashes);
      if (!result) return null;
      if (version !== this.#startVersion || result.projectId !== projectId
        || this.#options.getProjectId() !== projectId) {
        await this.#options.api.stopImportDirectoryWatch(result.watchId);
        if (result.projectId !== projectId) this.#options.onError(new Error('directory watch project mismatch'));
        return null;
      }
      const session = this.#createSession(result, hashes);
      for (const file of result.files) this.#enqueue(session, file);
      await session.queue;
      if (this.#isCurrent(session)) await this.#options.api.activateImportDirectoryWatch(session.watchId);
      return this.#isCurrent(session) ? this.activeWatch : null;
    } catch (reason) {
      this.#options.onError(reason);
      await this.stop();
      return null;
    } finally {
      this.#options.onBusyChange(false);
    }
  }

  handleEvent(event: DirectoryImportEvent): void {
    const session = this.#session;
    if (!session || event.watchId !== session.watchId) return;
    if (event.projectId !== session.projectId) {
      this.#enqueueRejection(session, event.file);
      return;
    }
    this.#enqueue(session, event.file);
  }

  async settle(): Promise<void> {
    await this.#session?.queue;
  }

  async stop(): Promise<void> {
    this.#startVersion += 1;
    const session = this.#session;
    this.#session = null;
    this.#options.onWatchChange(null);
    this.#options.onBusyChange(false);
    if (!session) return;
    session.cancelled = true;
    await session.queue;
    try {
      await this.#options.api.stopImportDirectoryWatch(session.watchId);
    } catch (reason) {
      this.#options.onError(reason);
    }
  }

  #createSession(result: DirectoryWatchStartResult, hashes: readonly string[]): RuntimeSession {
    const session: RuntimeSession = {
      watchId: result.watchId,
      projectId: result.projectId,
      directoryName: result.directoryName,
      acceptedHashes: new Set(hashes),
      cancelled: false,
      queue: Promise.resolve(),
    };
    this.#session = session;
    this.#options.onWatchChange({ watchId: session.watchId, directoryName: session.directoryName });
    return session;
  }

  #enqueue(session: RuntimeSession, file: DirectoryImportedFile): void {
    session.queue = session.queue
      .then(() => this.#processFile(session, file))
      .catch((reason: unknown) => this.#options.onError(reason));
  }

  #enqueueRejection(session: RuntimeSession, file: DirectoryImportedFile): void {
    session.queue = session.queue
      .then(() => this.#acknowledge(session, file, 'rejected'))
      .catch((reason: unknown) => this.#options.onError(reason));
  }

  async #processFile(session: RuntimeSession, file: DirectoryImportedFile): Promise<void> {
    let disposition: DirectoryImportDisposition = 'rejected';
    try {
      if (!this.#isCurrent(session)) return;
      const descriptorHash = normalizeSha256Hash(file.contentHash);
      if (descriptorHash && this.#hasContentHash(session, descriptorHash)) {
        disposition = 'duplicate';
        return;
      }
      const asset = await (this.#options.convert ?? directoryFileToAsset)(file, this.#options.getFps());
      if (!this.#isCurrent(session)) return;
      const hash = normalizeSha256Hash(asset.sourceContentHash);
      if (hash && this.#hasContentHash(session, hash)) disposition = 'duplicate';
      else {
        this.#options.ingest(asset);
        if (hash) session.acceptedHashes.add(hash);
        disposition = 'accepted';
      }
    } catch (reason) {
      this.#options.onError(reason);
    } finally {
      await this.#acknowledge(session, file, disposition);
    }
  }

  async #acknowledge(
    session: RuntimeSession,
    file: DirectoryImportedFile,
    disposition: DirectoryImportDisposition,
  ): Promise<void> {
    try {
      await this.#options.api.acknowledgeImportDirectoryFile(
        session.watchId,
        file.importId,
        disposition,
      );
    } catch (reason) {
      this.#options.onError(reason);
    }
  }

  #hasContentHash(session: RuntimeSession, hash: string): boolean {
    return session.acceptedHashes.has(hash)
      || this.#options.getAssets().some(
        (asset) => normalizeSha256Hash(asset.sourceContentHash) === hash,
      );
  }

  #isCurrent(session: RuntimeSession): boolean {
    return this.#session === session && !session.cancelled
      && this.#options.getProjectId() === session.projectId;
  }
}

export function bindDirectoryImportRuntime(
  api: DirectoryImportDesktopApi,
  runtime: DirectoryImportRuntime,
): () => Promise<void> {
  const unsubscribe = api.subscribeImportDirectory((event) => runtime.handleEvent(event));
  return async () => {
    unsubscribe();
    await runtime.stop();
  };
}

interface UseDirectoryImportOptions {
  projectId: string;
  fps: number;
  assets: readonly MediaAsset[];
  ingest: (asset: MediaAsset) => void;
  onError: (message: string | null) => void;
  t: typeof translate;
}

export interface UseDirectoryImportState {
  available: boolean;
  busy: boolean;
  activeWatch: ActiveDirectoryWatch | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

function directoryApiOf(value: Window['openChatCutDesktop']): DirectoryImportDesktopApi | null {
  if (!value || typeof value.startImportDirectoryWatch !== 'function'
    || typeof value.activateImportDirectoryWatch !== 'function'
    || typeof value.acknowledgeImportDirectoryFile !== 'function'
    || typeof value.stopImportDirectoryWatch !== 'function'
    || typeof value.subscribeImportDirectory !== 'function') return null;
  return value;
}

export function useDirectoryImport(options: UseDirectoryImportOptions): UseDirectoryImportState {
  const optionsRef = useRef(options); optionsRef.current = options;
  const api = directoryApiOf(window.openChatCutDesktop);
  const runtimeRef = useRef<DirectoryImportRuntime | null>(null);
  const [busy, setBusy] = useState(false); const [activeWatch, setActiveWatch] = useState<ActiveDirectoryWatch | null>(null);

  useEffect(() => {
    setBusy(false); setActiveWatch(null);
    if (!api) {
      runtimeRef.current = null;
      return;
    }
    let live = true;
    const runtime = new DirectoryImportRuntime({
      api,
      getProjectId: () => optionsRef.current.projectId,
      getFps: () => optionsRef.current.fps,
      getAssets: () => optionsRef.current.assets,
      ingest: (asset) => optionsRef.current.ingest(asset),
      onWatchChange: (watch) => { if (live) setActiveWatch(watch); },
      onBusyChange: (next) => { if (live) setBusy(next); },
      onError: (reason) => {
        if (!live) return;
        optionsRef.current.onError(optionsRef.current.t('监听文件夹导入失败：{error}', {
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      },
    });
    runtimeRef.current = runtime;
    const release = bindDirectoryImportRuntime(api, runtime);
    return () => {
      live = false;
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      void release();
    };
  }, [api]);

  useEffect(() => {
    optionsRef.current.onError(null); void runtimeRef.current?.stop();
  }, [options.projectId]);

  const start = useCallback(async () => {
    optionsRef.current.onError(null);
    await runtimeRef.current?.start();
  }, []);
  const stop = useCallback(async () => {
    await runtimeRef.current?.stop();
  }, []);
  return { available: api !== null, busy, activeWatch, start, stop };
}
