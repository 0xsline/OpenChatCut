// Settings-side endpoints for the xAI subscription session: status, import
// from the official Grok CLI login, and logout. Token storage and refresh
// live in server/xai-oauth-session.ts; secrets never cross this boundary.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { trustedEditorRequest } from '../editor-auth.ts';
import {
  importXaiOauthFromCli,
  initXaiOauth,
  logoutXaiOauth,
  xaiOauthStatus,
} from '../xai-oauth-session.ts';

const BODY_LIMIT = 16 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function xaiOauthPlugin(): Plugin {
  return {
    name: 'openchatcut-xai-oauth',
    configureServer(server) {
      void initXaiOauth().catch((error) => {
        server.config.logger.error(`[xai-oauth] ${messageOf(error)}`);
      });
      server.middlewares.use('/api/xai-oauth', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const write = req.method === 'POST';
          // Reads only report session shape (never token values); writes
          // require the same-origin loopback request shape as other pages.
          if (!trustedEditorRequest(req, write)) {
            sendJson(res, 403, { error: 'untrusted editor request' });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/status') {
            sendJson(res, 200, xaiOauthStatus());
            return;
          }
          if (write && url.pathname === '/import') {
            await readBody(req);
            sendJson(res, 200, await importXaiOauthFromCli());
            return;
          }
          if (write && url.pathname === '/logout') {
            await readBody(req);
            await logoutXaiOauth();
            sendJson(res, 200, xaiOauthStatus());
            return;
          }
          sendJson(res, 405, { error: 'method not allowed' });
        } catch (error) {
          if (!res.headersSent) sendJson(res, 400, { error: messageOf(error).slice(0, 240) });
        }
      });
    },
  };
}
