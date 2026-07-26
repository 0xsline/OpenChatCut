import { contextBridge, ipcRenderer } from 'electron';

export type KikiLoginResult = {
  state: 'connected' | 'expired' | 'missing' | 'requires-desktop';
  authenticated: boolean;
};

export interface OpenChatCutDesktopApi {
  selectDirectory(defaultPath?: string): Promise<string | null>;
  /** Open kikivoice.ai in a persist:partition window; resolves once auth cookies land. Desktop only. */
  kikiLogin(): Promise<KikiLoginResult>;
}

const api: OpenChatCutDesktopApi = {
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke('openchatcut:select-directory', defaultPath) as Promise<string | null>,
  kikiLogin: () => ipcRenderer.invoke('openchatcut:kiki-login') as Promise<KikiLoginResult>,
};

contextBridge.exposeInMainWorld('openChatCutDesktop', api);
