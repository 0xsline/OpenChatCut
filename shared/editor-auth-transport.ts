export const EDITOR_CREDENTIALS_CHANNEL = 'openchatcut:editor-credentials';

export interface EditorBootstrapInfo {
  editorToken: string;
  /** Available only through the trusted Electron IPC bridge. */
  mcpToken?: string;
}
