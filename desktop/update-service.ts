import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type {
  DesktopUpdateCheckSource,
  DesktopUpdateOperation,
  DesktopUpdateState,
} from '../shared/desktop-update.ts';

export interface DesktopUpdateServiceOptions {
  readonly enabled: boolean;
  readonly currentVersion: string;
}

type UpdateStateListener = (state: DesktopUpdateState) => void;

function releaseVersion(info: UpdateInfo): string {
  return info.version.trim().replace(/^v/i, '');
}

export class DesktopUpdateService {
  private readonly listeners = new Set<UpdateStateListener>();
  private readonly updater: AppUpdater;
  private readonly options: DesktopUpdateServiceOptions;
  private activeOperation: DesktopUpdateOperation = 'check';
  private state: DesktopUpdateState;

  constructor(updater: AppUpdater, options: DesktopUpdateServiceOptions) {
    this.updater = updater;
    this.options = options;
    this.state = {
      phase: options.enabled ? 'idle' : 'unsupported',
      source: 'auto',
      currentVersion: options.currentVersion,
    };
    if (options.enabled) this.configureUpdater();
  }

  private configureUpdater(): void {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = false;
    this.updater.on('checking-for-update', () => {
      this.publish({ ...this.state, phase: 'checking' });
    });
    this.updater.on('update-available', (info: UpdateInfo) => {
      this.publish({
        phase: 'available',
        source: this.state.source,
        currentVersion: this.options.currentVersion,
        latestVersion: releaseVersion(info),
      });
    });
    this.updater.on('update-not-available', (info: UpdateInfo) => {
      this.publish({
        phase: 'current',
        source: this.state.source,
        currentVersion: this.options.currentVersion,
        latestVersion: releaseVersion(info),
      });
    });
    this.updater.on('download-progress', (progress: ProgressInfo) => {
      this.publish({
        ...this.state,
        phase: 'downloading',
        percent: Math.min(100, Math.max(0, progress.percent)),
      });
    });
    this.updater.on('update-downloaded', (info: UpdateInfo) => {
      this.publish({
        phase: 'downloaded',
        source: this.state.source,
        currentVersion: this.options.currentVersion,
        latestVersion: releaseVersion(info),
        percent: 100,
      });
    });
    this.updater.on('error', () => { this.fail(this.activeOperation); });
  }

  private publish(next: DesktopUpdateState): void {
    this.state = next;
    this.listeners.forEach((listener) => { listener(next); });
  }

  private fail(operation: DesktopUpdateOperation): void {
    this.publish({
      phase: 'error',
      source: this.state.source,
      currentVersion: this.options.currentVersion,
      latestVersion: this.state.latestVersion,
      failedOperation: operation,
    });
  }

  getState(): DesktopUpdateState {
    return this.state;
  }

  subscribe(listener: UpdateStateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async check(source: DesktopUpdateCheckSource): Promise<DesktopUpdateState> {
    if (!this.options.enabled) return this.state;
    if (['checking', 'downloading', 'installing'].includes(this.state.phase)) return this.state;
    this.activeOperation = 'check';
    this.publish({
      phase: 'checking',
      source,
      currentVersion: this.options.currentVersion,
    });
    try {
      const result = await this.updater.checkForUpdates();
      if (!result && this.state.phase === 'checking') this.fail('check');
    } catch {
      if (this.state.phase === 'checking') this.fail('check');
    }
    return this.state;
  }

  async download(): Promise<DesktopUpdateState> {
    const canDownload = this.state.phase === 'available'
      || (this.state.phase === 'error' && this.state.failedOperation === 'download');
    if (!this.options.enabled || !canDownload || !this.state.latestVersion) return this.state;
    this.activeOperation = 'download';
    this.publish({ ...this.state, phase: 'downloading', percent: 0, failedOperation: undefined });
    try {
      await this.updater.downloadUpdate();
      if (this.state.phase === 'downloading') this.fail('download');
    } catch {
      if (this.state.phase === 'downloading') this.fail('download');
    }
    return this.state;
  }

  install(): DesktopUpdateState {
    const canInstall = this.state.phase === 'downloaded'
      || (this.state.phase === 'error' && this.state.failedOperation === 'install');
    if (!this.options.enabled || !canInstall || !this.state.latestVersion) return this.state;
    this.activeOperation = 'install';
    this.publish({ ...this.state, phase: 'installing', failedOperation: undefined });
    globalThis.setTimeout(() => {
      try {
        this.updater.quitAndInstall();
      } catch {
        this.fail('install');
      }
    }, 0);
    return this.state;
  }
}
