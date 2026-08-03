import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}

export interface DesktopExportFileGrant extends DesktopExportDirectoryGrant {
  readonly filename: string;
}

export interface OpenChatCutDesktopApi {
  getPathForFile(file: File): string | undefined;
  platform: NodeJS.Platform;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
  selectExportFile(suggestedFilename: string): Promise<DesktopExportFileGrant | null>;
  restoreExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
  importLocalMedia(file: File): Promise<{ src: string; storedName: string } | null>;
  prepareTransparentMovProxy(storedName: string): Promise<{ src: string } | null>;
  windowAction(action: 'close' | 'minimize' | 'toggle-maximize'): Promise<void>;
  revealExport(destinationId: string, filename: string): Promise<void>;
}

const api: OpenChatCutDesktopApi = {
  getPathForFile: (file) => webUtils.getPathForFile(file) || undefined,
  platform: process.platform,
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke('openchatcut:select-directory', defaultPath) as Promise<string | null>,
  selectExportDirectory: () =>
    ipcRenderer.invoke('openchatcut:select-export-directory') as Promise<DesktopExportDirectoryGrant | null>,
  selectExportFile: (suggestedFilename) =>
    ipcRenderer.invoke('openchatcut:select-export-file', suggestedFilename) as Promise<DesktopExportFileGrant | null>,
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
  windowAction: (action) =>
    ipcRenderer.invoke('openchatcut:window-action', action) as Promise<void>,
  revealExport: (destinationId, filename) =>
    ipcRenderer.invoke('openchatcut:reveal-export', destinationId, filename) as Promise<void>,
};

contextBridge.exposeInMainWorld('openChatCutDesktop', api);
