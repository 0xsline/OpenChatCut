import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { keyStatus, setKeys } from './vite-keystore.ts';

// Dev-only settings endpoint bound to the Vite dev server (localhost). Key VALUES flow
// browser → server here and are stored server-side + in .env.local; they never flow back
// (GET returns booleans only). Mirrors ChatCut's server-side key handling.
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 100_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // Generic message on purpose: V8's SyntaxError can echo the raw body (which may
    // contain a key value) and our catch-all logs error messages.
    throw new Error('invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function settingsPlugin(): Plugin {
  return {
    name: 'chatcut-settings',
    configureServer(server) {
      server.middlewares.use('/api/keys', async (req, res) => {
        try {
          if (req.method === 'GET') { sendJson(res, 200, keyStatus()); return; }
          if (req.method === 'POST') {
            await setKeys(await readBody(req));
            sendJson(res, 200, keyStatus());
            return;
          }
          sendJson(res, 405, { error: 'method not allowed — use GET or POST' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[settings] ${message}`);  // message only — never a key value
          if (!res.headersSent) sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
