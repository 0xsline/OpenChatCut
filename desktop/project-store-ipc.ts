import { ipcMain } from 'electron';
import { PROJECT_STORE_CHANNEL } from '../shared/project-store-transport.ts';
import { executeProjectStoreRequest } from '../server/project-store-transport.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';

export function installProjectStoreIpc(trustedOrigin: string): void {
  ipcMain.handle(PROJECT_STORE_CHANNEL, (event, value: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return executeProjectStoreRequest(value);
  });
}
