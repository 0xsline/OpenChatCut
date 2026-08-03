export {};
interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}

declare global {
  interface Window {
    openChatCutDesktop?: {
      getPathForFile(file: File): string | undefined;
      platform: NodeJS.Platform;
      selectDirectory(defaultPath?: string): Promise<string | null>;
      selectExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
      restoreExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
      importLocalMedia(file: File): Promise<{ src: string; storedName: string } | null>;
      prepareTransparentMovProxy(storedName: string): Promise<{ src: string } | null>;
      windowAction(action: 'close' | 'minimize' | 'toggle-maximize'): Promise<void>;
    };
  }
}
