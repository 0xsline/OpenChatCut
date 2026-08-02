export {};
interface DesktopExportDirectoryGrant {
  readonly grantId: string;
  readonly label: string;
}

declare global {
  interface Window {
    openChatCutDesktop?: {
      selectDirectory(defaultPath?: string): Promise<string | null>;
      selectExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
      restoreExportDirectory(): Promise<DesktopExportDirectoryGrant | null>;
      revealExport(filename: string): Promise<void>;
    };
  }
}
