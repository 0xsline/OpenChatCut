import { ipcMain } from 'electron';
import { EDITOR_CREDENTIALS_CHANNEL } from '../shared/editor-auth-transport.ts';
import { editorBootstrapPayload } from '../server/editor-auth.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';


export function installEditorAuthIpc(trustedOrigin: string): void {
  ipcMain.handle(EDITOR_CREDENTIALS_CHANNEL, (event) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return editorBootstrapPayload();
  });
}
