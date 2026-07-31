import { contextBridge, ipcRenderer } from 'electron';

export interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}

export interface OpenChatCutDesktopApi {
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
  restoreExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
}

const api: OpenChatCutDesktopApi = {
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke('openchatcut:select-directory', defaultPath) as Promise<string | null>,
  selectExportDirectory: () =>
    ipcRenderer.invoke('openchatcut:select-export-directory') as Promise<DesktopExportDirectoryGrant | null>,
  restoreExportDirectory: () =>
    ipcRenderer.invoke('openchatcut:restore-export-directory') as Promise<DesktopExportDirectoryGrant | null>,
};

contextBridge.exposeInMainWorld('openChatCutDesktop', api);
