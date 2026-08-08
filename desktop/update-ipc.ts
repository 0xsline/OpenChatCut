import { app, BrowserWindow, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
import {
  DESKTOP_UPDATE_CHANNELS,
  isDesktopUpdateCheckSource,
  type DesktopUpdateState,
} from '../shared/desktop-update.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import { DesktopUpdateService } from './update-service.ts';

const { autoUpdater } = electronUpdater;

interface DesktopUpdateIpcOptions {
  readonly enabled: boolean;
}

function publishUpdateState(state: DesktopUpdateState): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_UPDATE_CHANNELS.state, state);
  });
}

export function installDesktopUpdateIpc(
  trustedOrigin: string,
  options: DesktopUpdateIpcOptions,
): DesktopUpdateService {
  const service = new DesktopUpdateService(autoUpdater, {
    enabled: options.enabled,
    currentVersion: app.getVersion(),
  });
  service.subscribe(publishUpdateState);

  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.getState, (event) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return service.getState();
  });
  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.check, async (event, source: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (!isDesktopUpdateCheckSource(source)) throw new Error('invalid update check source');
    return service.check(source);
  });
  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.download, async (event) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return service.download();
  });
  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.install, (event) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return service.install();
  });

  return service;
}
