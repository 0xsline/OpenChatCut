import type { EditorBootstrapInfo } from '../../shared/editor-auth-transport';
import { editorSessionCredentialHeaders } from '../persist/projectStoreTransport';

export const EDITOR_CREDENTIAL_HEADER = 'X-OpenChatCut-Editor-Credential';
const EDITOR_BOOTSTRAP_HEADER = 'X-OpenChatCut-Editor-Bootstrap';


let cached: EditorBootstrapInfo | null = null;
let pending: Promise<EditorBootstrapInfo> | null = null;

async function requestEditorBootstrap(signal?: AbortSignal): Promise<EditorBootstrapInfo> {
  let value: unknown;
  const desktop = typeof window !== 'undefined'
    ? window.openChatCutDesktop?.editorCredentials
    : undefined;
  if (desktop) {
    value = await desktop();
  } else {
    const response = await fetch('/api/external-agent/bootstrap', {
      method: 'POST',
      headers: await editorSessionCredentialHeaders({
        'Content-Type': 'application/json',
        [EDITOR_BOOTSTRAP_HEADER]: '1',
      }),
      body: '{}',
      signal,
    });
    if (!response.ok) throw new Error(`editor bootstrap failed: HTTP ${response.status}`);
    value = await response.json();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('credential' in value) || typeof value.credential !== 'string' || !value.credential
    || !('mcpToken' in value) || typeof value.mcpToken !== 'string' || !value.mcpToken) {
    throw new Error('editor bootstrap returned invalid credentials');
  }
  return { credential: value.credential, mcpToken: value.mcpToken };
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

export async function editorCredentialHeaders(
  headers?: HeadersInit,
  signal?: AbortSignal,
): Promise<Headers> {
  const result = new Headers(headers);
  result.set(EDITOR_CREDENTIAL_HEADER, (await editorBootstrapInfo(signal)).credential);
  return result;
}
