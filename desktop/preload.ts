import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  importLocalMediaFromFile,
  type LocalMediaPreloadDependencies,
} from './local-media-bridge.ts';
import {
  PROJECT_STORE_CHANNEL,
  type ProjectStoreRequest,
  type ProjectStoreResponse,
} from '../shared/project-store-transport.ts';
import {
  EDITOR_CREDENTIALS_CHANNEL,
  type EditorBootstrapInfo,
} from '../shared/editor-auth-transport.ts';
import {
  DESKTOP_UPDATE_CHANNELS,
  isDesktopUpdateState,
  type DesktopUpdateCheckSource,
  type DesktopUpdateState,
} from '../shared/desktop-update.ts';

export interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}

export interface DesktopExportFileGrant extends DesktopExportDirectoryGrant {
  readonly filename: string;
}

export interface DesktopUpdateApi {
  getState(): Promise<DesktopUpdateState>;
  check(source: DesktopUpdateCheckSource): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): Promise<DesktopUpdateState>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}

export interface OpenChatCutDesktopApi {
  getPathForFile(file: File): string | undefined;
  platform: NodeJS.Platform;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
  selectExportFile(suggestedFilename: string): Promise<DesktopExportFileGrant | null>;
  restoreExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
  importLocalMedia(file: File): Promise<{ src: string; storedName: string; contentHash: string } | null>;
  prepareTransparentMovProxy(storedName: string): Promise<{ src: string } | null>;
  windowAction(action: 'close' | 'minimize' | 'toggle-maximize'): Promise<void>;
  revealExport(destinationId: string, filename: string): Promise<void>;
  projectStore(request: ProjectStoreRequest): Promise<ProjectStoreResponse>;
  editorCredentials(): Promise<EditorBootstrapInfo>;
  updates: DesktopUpdateApi;
}

const localMediaPreloadDependencies: LocalMediaPreloadDependencies<File> = {
  getPathForFile: webUtils.getPathForFile.bind(webUtils),
  invoke: ipcRenderer.invoke.bind(ipcRenderer),
};

async function invokeDesktopUpdate(
  channel: string,
  ...args: unknown[]
): Promise<DesktopUpdateState> {
  const state: unknown = await ipcRenderer.invoke(channel, ...args);
  if (!isDesktopUpdateState(state)) throw new Error('invalid desktop update state');
  return state;
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
  importLocalMedia: (file) => importLocalMediaFromFile(file, localMediaPreloadDependencies),
  prepareTransparentMovProxy: (storedName) =>
    ipcRenderer.invoke('openchatcut:transparent-mov-proxy', storedName) as Promise<{ src: string } | null>,
  windowAction: (action) =>
    ipcRenderer.invoke('openchatcut:window-action', action) as Promise<void>,
  revealExport: (destinationId, filename) =>
    ipcRenderer.invoke('openchatcut:reveal-export', destinationId, filename) as Promise<void>,
  projectStore: (request) =>
    ipcRenderer.invoke(PROJECT_STORE_CHANNEL, request) as Promise<ProjectStoreResponse>,
  editorCredentials: () =>
    ipcRenderer.invoke(EDITOR_CREDENTIALS_CHANNEL) as Promise<EditorBootstrapInfo>,
  updates: {
    getState: () => invokeDesktopUpdate(DESKTOP_UPDATE_CHANNELS.getState),
    check: (source) => invokeDesktopUpdate(DESKTOP_UPDATE_CHANNELS.check, source),
    download: () => invokeDesktopUpdate(DESKTOP_UPDATE_CHANNELS.download),
    install: () => invokeDesktopUpdate(DESKTOP_UPDATE_CHANNELS.install),
    subscribe: (listener) => {
      const handleState = (_event: IpcRendererEvent, state: unknown): void => {
        if (isDesktopUpdateState(state)) listener(state);
      };
      ipcRenderer.on(DESKTOP_UPDATE_CHANNELS.state, handleState);
      return () => { ipcRenderer.removeListener(DESKTOP_UPDATE_CHANNELS.state, handleState); };
    },
  },
};

contextBridge.exposeInMainWorld('openChatCutDesktop', api);
