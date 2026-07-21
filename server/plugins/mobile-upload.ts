import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { MobileUploadService } from '../mobile-upload-service.ts';
import { putUploadFile } from '../r2.ts';
import { maxUploadBytes } from './upload.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.');
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

      server.middlewares.use('/api/mobile-upload', async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          sendJson(res, 403, { error: 'mobile upload controls are loopback-only' });
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (req.method === 'POST' && url.pathname === '/sessions') {
            sendJson(res, 201, await service.createSession(url.searchParams.get('locale') === 'en' ? 'en' : 'zh'));
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
      });
    },
  };
}
