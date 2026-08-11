import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import {
  DesktopUpdateService,
  supportsDirectDesktopUpdates,
} from './update-service';

function updateInfo(version: string): UpdateInfo {
  return { version, releaseDate: new Date(0).toISOString(), files: [], path: '', sha512: '' };
}

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  nextVersion = '0.2.0';
  available = true;
  failDownload = false;

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    this.emit('checking-for-update');
    const info = updateInfo(this.nextVersion);
    this.emit(this.available ? 'update-available' : 'update-not-available', info);
    return { isUpdateAvailable: this.available, updateInfo: info, versionInfo: info };
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadCalls += 1;
    if (this.failDownload) {
      const error = new Error('download failed');
      this.emit('error', error);
      throw error;
    }
    this.emit('download-progress', { percent: 42, bytesPerSecond: 1, total: 10, transferred: 4 });
    this.emit('update-downloaded', updateInfo(this.nextVersion));
    return ['/tmp/update'];
  }

  quitAndInstall(): void {
    this.installCalls += 1;
  }
}

for (const platform of ['win32', 'linux'] satisfies NodeJS.Platform[]) {
  assert.equal(
    supportsDirectDesktopUpdates({ packaged: true, smoke: false, platform }),
    true,
    `${platform} packaged builds must support direct updates`,
  );
}
assert.equal(
  supportsDirectDesktopUpdates({ packaged: true, smoke: false, platform: 'darwin' }),
  false,
  'ad-hoc signed macOS builds must use the release-page fallback',
);
assert.equal(
  supportsDirectDesktopUpdates({ packaged: false, smoke: false, platform: 'win32' }),
  false,
  'development builds must not contact update servers',
);
assert.equal(
  supportsDirectDesktopUpdates({ packaged: true, smoke: true, platform: 'linux' }),
  false,
  'smoke builds must not contact update servers',
);

const unsupportedUpdater = new FakeUpdater();
const unsupported = new DesktopUpdateService(unsupportedUpdater as unknown as AppUpdater, {
  enabled: false,
  currentVersion: '0.1.9',
});
assert.equal(unsupported.getState().phase, 'unsupported');
await unsupported.check('manual');
assert.equal(unsupportedUpdater.checkCalls, 0, 'development and smoke builds must not contact update servers');

const fake = new FakeUpdater();
const service = new DesktopUpdateService(fake as unknown as AppUpdater, {
  enabled: true,
  currentVersion: '0.1.9',
});
assert.equal(fake.autoDownload, false, 'updates require an explicit user download action');
assert.equal(fake.autoInstallOnAppQuit, false, 'downloaded updates must not install on an unrelated quit');
assert.equal(fake.allowDowngrade, false);
assert.equal(fake.allowPrerelease, false);

const observed: string[] = [];
service.subscribe((next) => { observed.push(next.phase); });
const available = await service.check('manual');
assert.equal(available.phase, 'available');
assert.equal(available.latestVersion, '0.2.0');
assert.equal(observed.at(-1), 'available');

const downloaded = await service.download();
assert.equal(downloaded.phase, 'downloaded');
assert.equal(downloaded.percent, 100);
assert.equal(fake.downloadCalls, 1);
assert.ok(observed.includes('downloading'), 'download progress must be observable by the renderer');

const installing = service.install();
assert.equal(installing.phase, 'installing');
assert.equal(fake.installCalls, 0, 'IPC must receive the installing state before the app exits');
await delay(0);
assert.equal(fake.installCalls, 1);

const retryFake = new FakeUpdater();
const retryService = new DesktopUpdateService(retryFake as unknown as AppUpdater, {
  enabled: true,
  currentVersion: '0.1.9',
});
await retryService.check('manual');
retryFake.failDownload = true;
assert.equal((await retryService.download()).failedOperation, 'download');
retryFake.failDownload = false;
assert.equal((await retryService.download()).phase, 'downloaded', 'a failed download must remain retryable');

const currentFake = new FakeUpdater();
currentFake.available = false;
currentFake.nextVersion = '0.1.9';
const currentService = new DesktopUpdateService(currentFake as unknown as AppUpdater, {
  enabled: true,
  currentVersion: '0.1.9',
});
assert.equal((await currentService.check('manual')).phase, 'current');
assert.equal(currentService.install().phase, 'current', 'install is forbidden before an update is downloaded');
assert.equal(currentFake.installCalls, 0);

console.log('update-service.verify: explicit check, download, retry, progress, and install lifecycle OK');
