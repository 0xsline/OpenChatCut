export {};

declare global {
  interface Window {
    openChatCutDesktop?: {
      selectDirectory(defaultPath?: string): Promise<string | null>;
      kikiLogin(): Promise<{ state: 'connected' | 'expired' | 'missing' | 'requires-desktop'; authenticated: boolean }>;
    };
  }
}
