import type { EditorBootstrapInfo } from '../../shared/editor-auth-transport';
import { fetchWithEditorSession } from '../persist/projectStoreTransport';

export const EDITOR_BOOTSTRAP_HEADER = 'X-OpenChatCut-Editor-Bootstrap';

let cached: EditorBootstrapInfo | null = null;
let pending: Promise<EditorBootstrapInfo> | null = null;

async function requestEditorBootstrap(signal?: AbortSignal): Promise<EditorBootstrapInfo> {
  let value: unknown;
  const desktopWindow = typeof window === 'undefined' ? undefined : window as typeof window & {
    openChatCutDesktop?: { editorCredentials?: () => Promise<EditorBootstrapInfo> };
  };
  const desktop = desktopWindow?.openChatCutDesktop?.editorCredentials;
  if (desktop) {
    value = await desktop();
  } else {
    const response = await fetchWithEditorSession('/api/external-agent/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [EDITOR_BOOTSTRAP_HEADER]: '1',
      },
      body: '{}',
      signal,
    });
    if (!response.ok) throw new Error(`editor bootstrap failed: HTTP ${response.status}`);
    value = await response.json();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('mcpToken' in value) || typeof value.mcpToken !== 'string' || !value.mcpToken) {
    throw new Error('editor bootstrap returned invalid credentials');
  }
  return { mcpToken: value.mcpToken };
}

export async function editorBootstrapInfo(signal?: AbortSignal): Promise<EditorBootstrapInfo> {
  if (cached) return cached;
  pending ??= requestEditorBootstrap(signal);
  try {
    cached = await pending;
    return cached;
  } finally {
    pending = null;
  }
}

export function invalidateEditorBootstrapInfo(): void {
  cached = null;
  pending = null;
}
