import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { keyStatus, setKeys } from '../keystore.ts';
import { runProbe } from '../key-probes.ts';
import {
  checkMediaDir,
  DEFAULT_UPLOAD_DIR,
  expandMediaDir,
  syncUploadDirectories,
  uploadDir,
} from '../media-dir.ts';

// Dev-only settings endpoint bound to the Vite dev server (localhost). Key VALUES flow
// browser → server here and are stored server-side + in .env.local; they never flow back
// (GET returns booleans only); keys never leave the server.
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
    name: 'openchatcut-settings',
    configureServer(server) {
      server.middlewares.use('/api/keys', async (req, res) => {
        try {
          if (req.method === 'GET') { sendJson(res, 200, keyStatus()); return; }
          // POST /api/keys/test:「测试连接」探测。overrides = 面板未保存的暂存值,
          // 仅本次探测生效,不落 keystore / .env.local;结果永不含密钥值。
          if (req.method === 'POST' && req.url === '/test') {
            const body = await readBody(req);
            const page = typeof body.page === 'string' ? body.page : '';
            const overrides = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
              ? body.overrides as Record<string, unknown>
              : {};
            sendJson(res, 200, await runProbe(page, overrides));
            return;
          }
          if (req.method === 'POST') {
            const patch = await readBody(req);
            const previousMediaDir = uploadDir();
            if ('MEDIA_DIR' in patch) {
              const rawMediaDir = String(patch.MEDIA_DIR ?? '');
              const checked = await checkMediaDir(rawMediaDir);
              if (!checked.ok) throw new Error(checked.error ?? 'invalid media directory');
              const nextMediaDir = expandMediaDir(rawMediaDir) ?? DEFAULT_UPLOAD_DIR;
              await syncUploadDirectories(
                previousMediaDir,
                nextMediaDir,
                (msg) => server.config.logger.info(msg),
              );
            }
            await setKeys(patch);
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
