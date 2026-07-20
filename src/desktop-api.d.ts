export {};

declare global {
  interface Window {
    openChatCutDesktop?: {
      selectDirectory(defaultPath?: string): Promise<string | null>;
    };
  }
}
