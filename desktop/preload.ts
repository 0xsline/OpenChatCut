import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}

export interface OpenChatCutDesktopApi {
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
  restoreExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
  importLocalMedia(file: File): Promise<{ src: string; storedName: string } | null>;
  prepareTransparentMovProxy(storedName: string): Promise<{ src: string } | null>;
}

const api: OpenChatCutDesktopApi = {
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke('openchatcut:select-directory', defaultPath) as Promise<string | null>,
  selectExportDirectory: () =>
    ipcRenderer.invoke('openchatcut:select-export-directory') as Promise<DesktopExportDirectoryGrant | null>,
  restoreExportDirectory: () =>
    ipcRenderer.invoke('openchatcut:restore-export-directory') as Promise<DesktopExportDirectoryGrant | null>,
  importLocalMedia: (file) => {
    let sourcePath = '';
    try {
      sourcePath = webUtils.getPathForFile(file);
    } catch {
      // Clipboard-created blobs have no native path and retain the browser fallback.
      return Promise.resolve(null);
    }
    if (!sourcePath) return Promise.resolve(null);
    return ipcRenderer.invoke(
      'openchatcut:import-local-media',
      sourcePath,
      file.name,
    ) as Promise<{ src: string; storedName: string }>;
  },
  prepareTransparentMovProxy: (storedName) =>
    ipcRenderer.invoke('openchatcut:transparent-mov-proxy', storedName) as Promise<{ src: string } | null>,
};

contextBridge.exposeInMainWorld('openChatCutDesktop', api);
