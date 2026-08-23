import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { editorCredentialAuthorized, trustedEditorRequest } from '../editor-auth.ts';
import { MobileUploadService } from '../mobile-upload-service.ts';
import { putUploadFile } from '../r2.ts';
import { maxUploadBytes } from './upload.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

type MobileUploadControls = Pick<MobileUploadService, 'createSession' | 'getSession' | 'closeSession'>;

function mobileUploadControlAuthorized(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET') {
    if (trustedEditorRequest(req, false)) return true;
    req.resume();
    sendJson(res, 403, { error: 'untrusted editor request' });
    return false;
  }
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (editorCredentialAuthorized(req, true)) return true;
    req.resume();
    sendJson(res, 401, { error: 'editor credential required' });
    return false;
  }
  return true;
}

function mobilePageLocale(value: string | null): 'zh' | 'en' | 'it' {
  return value === 'en' || value === 'it' ? value : 'zh';
}

export async function handleMobileUploadControl(
  req: IncomingMessage,
  res: ServerResponse,
  service: MobileUploadControls,
): Promise<void> {
  if (!mobileUploadControlAuthorized(req, res)) return;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/sessions') {
      sendJson(res, 201, await service.createSession(mobilePageLocale(url.searchParams.get('locale'))));
      return;
    }
    const match = /^\/sessions\/([0-9a-f-]+)$/.exec(url.pathname);
    if (!match) { sendJson(res, 404, { error: 'not found' }); return; }
    if (req.method === 'GET') {
      const snapshot = service.getSession(match[1]!);
      sendJson(res, snapshot ? 200 : 404, snapshot ?? { error: 'session not found or expired' });
      return;
    }
    if (req.method === 'DELETE') {
      const snapshot = await service.closeSession(match[1]!);
      sendJson(res, snapshot ? 200 : 404, snapshot ?? { error: 'session not found or expired' });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /no LAN IPv4/i.test(message) ? 503 : 500;
    sendJson(res, status, { error: message });
  }
}

export function mobileUploadPlugin(): Plugin {
  return {
    name: 'openchatcut-mobile-upload',
    configureServer(server) {
      const service = new MobileUploadService({
        maxBytes: maxUploadBytes(),
        afterSave: (name, path, mime) => putUploadFile(name, path, mime),
        log: (message) => server.config.logger.warn(message),
      });
      server.httpServer?.once('close', () => { void service.stop(); });

      server.middlewares.use('/api/mobile-upload', (req: IncomingMessage, res: ServerResponse) => {
        void handleMobileUploadControl(req, res, service);
      });
    },
  };
}
