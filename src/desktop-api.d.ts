export {};
interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}

declare global {
  interface Window {
    openChatCutDesktop?: {
      getPathForFile(file: File): string | undefined;
      selectDirectory(defaultPath?: string): Promise<string | null>;
      selectExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
      restoreExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
    };
  }
}
