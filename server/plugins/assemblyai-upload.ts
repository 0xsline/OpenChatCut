import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getKey } from '../keystore.ts';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';

const MAX_JSON_BYTES = 8 * 1024;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ src?: unknown }> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new BodyTooLargeError('body too large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_JSON_BYTES) throw new BodyTooLargeError('body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { src?: unknown };
}

function uploadName(src: string): string | null {
  let clean: string;
  try {
    clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  } catch {
    return null;
  }
  const match = clean.match(/^\/media\/uploads\/([^/]+)$/);
  return match?.[1] && isSafeUploadName(match[1]) ? match[1] : null;
}

export interface AssemblyAiUploadDependencies {
  getApiKey?: () => string;
  resolveFile?: (name: string) => string | null;
  fetchUpstream?: typeof fetch;
  timeoutMs?: number;
}

export async function handleAssemblyAiUpload(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: AssemblyAiUploadDependencies = {},
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed — use POST' });
    return;
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 415, { error: 'content-type must be application/json' });
    return;
  }
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    sendJson(res, 403, { error: 'cross-site requests are not allowed' });
    return;
  }
  const origin = String(req.headers.origin ?? '').trim();
  if (origin) {
    let trustedOrigin = false;
    try {
      const parsed = new URL(origin);
      trustedOrigin = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.host === String(req.headers.host ?? '');
    } catch {
      trustedOrigin = false;
    }
    if (!trustedOrigin) {
      sendJson(res, 403, { error: 'untrusted request origin' });
      return;
    }
  }


  let clientClosed = false;
  const controller = new AbortController();
  const onClientClose = () => {
    if (res.writableEnded) return;
    clientClosed = true;
    controller.abort(new Error('client disconnected'));
  };
  req.once('aborted', onClientClose);
  res.once('close', onClientClose);

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let fileStream: ReturnType<typeof createReadStream> | undefined;
  let destroyOnAbort: (() => void) | undefined;
  try {
    const body = await readJson(req);
    const name = uploadName(String(body.src ?? '').trim());
    if (!name) {
      sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
      return;
    }
    const file = (dependencies.resolveFile ?? resolveUploadFile)(name);
    if (!file) {
      sendJson(res, 404, { error: `media not found: ${name}` });
      return;
    }
    const apiKey = (dependencies.getApiKey ?? (() => getKey('ASSEMBLYAI_API_KEY')))();
    if (!apiKey) {
      sendJson(res, 503, { error: 'AssemblyAI API key is not configured' });
      return;
    }
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0) {
      sendJson(res, 404, { error: `media not found: ${name}` });
      return;
    }
    if (controller.signal.aborted) return;

    const stream = createReadStream(file);
    fileStream = stream;
    destroyOnAbort = () => stream.destroy();
    controller.signal.addEventListener('abort', destroyOnAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('AssemblyAI upload timed out'));
    }, dependencies.timeoutMs ?? UPLOAD_TIMEOUT_MS);

    const response = await (dependencies.fetchUpstream ?? fetch)('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/octet-stream',
        'content-length': String(info.size),
      },
      body: Readable.toWeb(stream),
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const responseText = await response.text();
    if (!response.ok) {
      sendJson(res, 502, {
        error: `AssemblyAI upload failed: HTTP ${response.status}`,
        detail: responseText.slice(0, 500),
      });
      return;
    }
    let parsed: { upload_url?: unknown };
    try {
      parsed = JSON.parse(responseText) as { upload_url?: unknown };
    } catch {
      sendJson(res, 502, { error: 'AssemblyAI upload returned invalid JSON' });
      return;
    }
    if (typeof parsed.upload_url !== 'string' || !parsed.upload_url) {
      sendJson(res, 502, { error: 'AssemblyAI upload returned no upload URL' });
      return;
    }
    sendJson(res, 200, { uploadUrl: parsed.upload_url, bytes: info.size });
  } catch (error) {
    if (clientClosed || res.destroyed) return;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BodyTooLargeError) sendJson(res, 413, { error: message });
    else if (error instanceof SyntaxError) sendJson(res, 400, { error: 'invalid JSON body' });
    else if (timedOut) sendJson(res, 504, { error: message });
    else sendJson(res, 502, { error: message });
  } finally {
    clearTimeout(timer);
    if (destroyOnAbort) controller.signal.removeEventListener('abort', destroyOnAbort);
    fileStream?.destroy();
    req.off('aborted', onClientClose);
    res.off('close', onClientClose);
  }
}

export function assemblyAiUploadPlugin(): Plugin {
  return {
    name: 'openchatcut-assemblyai-upload',
    configureServer(server) {
      server.middlewares.use('/api/assemblyai-upload', (req, res) => {
        void handleAssemblyAiUpload(req, res);
      });
    },
  };
}
