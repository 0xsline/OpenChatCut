import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { editorCredentialAuthorized, trustedEditorRequest } from '../editor-auth.ts';

export const EDITOR_AUTH_RESPONSE_HEADER = 'x-openchatcut-editor-auth';

const MCP_PATH = '/api/external-mcp/mcp';
const BOOTSTRAP_PATH = '/api/external-agent/bootstrap';

/** Upload handoffs carry their own single-use, scope-bound credential. */
export function externalUploadHandoffRequest(req: IncomingMessage, pathname: string): boolean {
  const method = req.method?.toUpperCase();
  if (pathname !== '/upload' || (method !== 'POST' && method !== 'PUT')) return false;
  return new URL(req.url ?? '/', 'http://localhost').searchParams.has('handoff');
}

export function privilegedEditorPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/llm' || pathname.startsWith('/llm/')
    || pathname === '/assemblyai' || pathname.startsWith('/assemblyai/')
    || pathname === '/upload' || pathname.startsWith('/upload/')
    || pathname === '/generate' || pathname.startsWith('/generate/')
    || pathname === '/export' || pathname.startsWith('/export/')
    || pathname === '/render-still' || pathname.startsWith('/render-still/')
    || pathname === '/render-clip' || pathname.startsWith('/render-clip/')
    || pathname === '/e2b' || pathname.startsWith('/e2b/');
}

function sendDenied(res: ServerResponse, status: 401 | 403): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (status === 401) res.setHeader(EDITOR_AUTH_RESPONSE_HEADER, 'required');
  res.end(JSON.stringify({
    error: status === 401 ? 'editor authorization required' : 'untrusted editor request',
  }));
}

export function authorizePrivilegedEditorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const method = req.method?.toUpperCase();
  if (
    !privilegedEditorPath(pathname)
    || pathname === MCP_PATH
    || (pathname === BOOTSTRAP_PATH && method === 'POST')
    || externalUploadHandoffRequest(req, pathname)
  ) {
    next();
    return;
  }
  const requireOrigin = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (!trustedEditorRequest(req, requireOrigin)) {
    sendDenied(res, 403);
    return;
  }
  if (!editorCredentialAuthorized(req, requireOrigin)) {
    sendDenied(res, 401);
    return;
  }
  next();
}

export function editorApiAuthPlugin(): Plugin {
  return {
    name: 'openchatcut-editor-api-auth',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(authorizePrivilegedEditorRequest);
    },
  };
}
