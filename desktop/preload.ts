import { contextBridge, ipcRenderer } from 'electron';

export interface OpenChatCutDesktopApi {
  selectDirectory(defaultPath?: string): Promise<string | null>;
}

const api: OpenChatCutDesktopApi = {
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke('openchatcut:select-directory', defaultPath) as Promise<string | null>,
};

contextBridge.exposeInMainWorld('openChatCutDesktop', api);
