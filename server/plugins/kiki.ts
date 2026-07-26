// KikiVoice plugin — status probe route. Cookie capture + login happen in the Electron
// BrowserWindow (desktop); this endpoint reports session state so the Settings badge can render.
// Mirrors the firecrawlPlugin shape (vite middleware, works in dev + embedded-server).

import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { KikiClient } from '../kiki/kiki-client.ts';
import { ElectronKikiTransport } from '../kiki/electron-transport.ts';
import {
  getKikiBridge,
  getKikiQuota,
  KIKI_DEFAULT_BASE_URL,
  KIKI_DEFAULT_MODEL,
  KIKI_DEFAULT_UA,
} from '../kiki/session-bridge.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += b.length;
    if (size > 256 * 1024) throw new Error('cookie body too large');
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildClient(): KikiClient | null {
  const bridge = getKikiBridge();
  const session = bridge?.getSession() ?? null;
  if (!session) return null;
  const userAgent = bridge?.userAgent ?? KIKI_DEFAULT_UA;
  const transport = new ElectronKikiTransport({ getSession: () => session, userAgent });
  return new KikiClient({
    baseUrl: (bridge?.baseUrl ?? KIKI_DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: bridge?.model ?? KIKI_DEFAULT_MODEL,
    userAgent,
    transport,
    // Status probe never synthesizes; ref resolver is unreachable for check-status.
    getRefAudio: async () => {
      throw new Error('kiki status probe does not synthesize');
    },
  });
}

export function kikiPlugin(): Plugin {
  return {
    name: 'openchatcut-kiki',
    configureServer(server) {
      server.middlewares.use('/api/kiki/status', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed — use GET' });
          return;
        }
        if (!getKikiBridge()) {
          // Browser-dev / no Electron session registered.
          sendJson(res, 200, { state: 'requires-desktop', authenticated: false });
          return;
        }
        const client = buildClient();
        if (!client) {
          // Bridge registered but session not yet authenticated (login window pending).
          sendJson(res, 200, { state: 'missing', authenticated: false });
          return;
        }
        try {
          const authenticated = await client.checkStatus();
          sendJson(res, 200, { state: authenticated ? 'connected' : 'expired', authenticated });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.warn(`[kiki/status] ${message}`);
          sendJson(res, 200, { state: 'unknown', authenticated: null });
        }
      });

      // Manual-upload fallback (OpenCut-AI's proven path): inject a Netscape cookie export into
      // the persist:kiki session. Use when auto-Connect can't acquire the cookie (GeeTest hard).
      server.middlewares.use('/api/kiki/cookie', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const text = String(body.cookieText ?? '');
          const bridge = getKikiBridge();
          if (!bridge?.setCookiesFromNetscape) {
            sendJson(res, 200, { state: 'requires-desktop', set: 0 });
            return;
          }
          const set = text ? await bridge.setCookiesFromNetscape(text) : 0;
          sendJson(res, 200, { set, state: set > 0 ? 'connected' : 'missing' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.warn(`[kiki/cookie] ${message}`);
          sendJson(res, 200, { set: 0, state: 'missing', error: message });
        }
      });

      // Quota/usage — last quota_info captured from a create-task response (passive, no extra API call).
      server.middlewares.use('/api/kiki/quota', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed — use GET' }); return; }
        sendJson(res, 200, { quota: getKikiQuota() });
      });
    },
  };
}
