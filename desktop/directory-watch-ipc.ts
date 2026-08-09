import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import {
  DIRECTORY_IMPORT_CHANNELS,
  isDirectoryImportDisposition,
  isDirectoryImportOpaqueId,
  isDirectoryImportProjectId,
  normalizeDirectoryImportHashes,
} from '../shared/directory-import.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import { canonicalCurrentUploadDirectory } from './directory-watch-import.ts';
import {
  DirectoryWatchSession,
  type DirectoryWatchSessionOptions,
} from './directory-watch.ts';
import {
  DirectoryWatchController,
  type DirectoryWatchSender,
} from './directory-watch-controller.ts';
import {
  invokeDirectoryWatch,
  reportDirectoryWatchError,
} from './directory-watch-errors.ts';

async function selectImportDirectory(sender: DirectoryWatchSender): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(sender as WebContents);
  const options: OpenDialogOptions = { properties: ['openDirectory'] };
  const selection = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return selection.canceled ? null : (selection.filePaths[0] ?? null);
}

function createDirectoryWatchSession(options: DirectoryWatchSessionOptions): DirectoryWatchSession {
  return new DirectoryWatchSession(options);
}


export function installDirectoryWatchIpc(trustedOrigin: string): DirectoryWatchController {
  const controller = new DirectoryWatchController({
    selectDirectory: selectImportDirectory,
    realpath,
    canonicalUploadDirectory: canonicalCurrentUploadDirectory,
    randomId: randomUUID,
    createSession: createDirectoryWatchSession,
    reportError: reportDirectoryWatchError,
  });
  ipcMain.handle(DIRECTORY_IMPORT_CHANNELS.start, async (event, projectId: unknown, hashes: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    const normalizedHashes = normalizeDirectoryImportHashes(hashes);
    if (!isDirectoryImportProjectId(projectId) || !normalizedHashes) {
      throw new Error('invalid directory watch start request');
    }
    return invokeDirectoryWatch(
      'start',
      () => controller.start(event.sender, projectId, normalizedHashes),
    );
  });
  ipcMain.handle(DIRECTORY_IMPORT_CHANNELS.activate, async (event, watchId: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (!isDirectoryImportOpaqueId(watchId)) throw new Error('invalid directory watch grant');
    await invokeDirectoryWatch(
      'activate',
      () => controller.activate(event.sender, watchId),
    );
  });
  ipcMain.handle(DIRECTORY_IMPORT_CHANNELS.acknowledge, async (
    event, watchId: unknown, importId: unknown, disposition: unknown,
  ) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (!isDirectoryImportOpaqueId(watchId)
      || !isDirectoryImportOpaqueId(importId)
      || !isDirectoryImportDisposition(disposition)) {
      throw new Error('invalid directory import acknowledgement');
    }
    await invokeDirectoryWatch(
      'acknowledge',
      () => controller.acknowledge(event.sender, watchId, importId, disposition),
    );
  });
  ipcMain.handle(DIRECTORY_IMPORT_CHANNELS.stop, async (event, watchId: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (!isDirectoryImportOpaqueId(watchId)) throw new Error('invalid directory watch grant');
    await invokeDirectoryWatch(
      'stop',
      () => controller.stop(event.sender, watchId),
    );
  });
  return controller;
}
