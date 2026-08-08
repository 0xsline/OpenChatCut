export {};
import type {
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../shared/project-store-transport';
import type { EditorBootstrapInfo } from '../shared/editor-auth-transport';
import type {
  DesktopUpdateCheckSource,
  DesktopUpdateState,
} from '../shared/desktop-update';
interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}
interface DesktopExportFileGrant extends DesktopExportDirectoryGrant {
  readonly filename: string;
}

interface DesktopUpdateApi {
  getState(): Promise<DesktopUpdateState>;
  check(source: DesktopUpdateCheckSource): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): Promise<DesktopUpdateState>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}
declare global {
  interface Window {
    openChatCutDesktop?: {
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
    };
  }
}
