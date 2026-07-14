import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Imported media is written to public/media/uploads/ so the SAME path resolves
// in the Player preview AND the headless export (render.mjs overlays public/
// onto the bundle root). This is the local stand-in for ChatCut's S3 ingest.
const UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');
const MAX_BODY_BYTES = 300 * 1024 * 1024; // 300MB — local media files
const MAX_JSON_BYTES = 64 * 1024;
const IMPORT_TIMEOUT_MS = 60_000;

function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new Error('file too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const CT_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
};

function extFromUrlOrType(url: string, contentType: string | null, nameHint?: string): string {
  if (nameHint) {
    const e = extname(nameHint).toLowerCase().replace(/[^.a-z0-9]/g, '');
    if (e) return e;
  }
  const clean = url.split('?')[0].split('#')[0];
  const fromUrl = extname(clean).toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (fromUrl && fromUrl.length <= 6) return fromUrl;
  if (contentType) {
    const base = contentType.split(';')[0].trim().toLowerCase();
    if (CT_EXT[base]) return CT_EXT[base];
  }
  return '.bin';
}

/**
 * Dev-server plugin:
 * - POST /upload?name=…  raw body → public/media/uploads
 * - POST /api/import-url  JSON {url, name?} → server-side fetch remote media → uploads
 *   (local stand-in for source download_media / push_asset S3 ingest)
 */
export function uploadPlugin(): Plugin {
  return {
    name: 'chatcut-upload',
    configureServer(server) {
      // POST /upload?name=…&assetId=…  raw body → public/media/uploads
      // Optional assetId makes the path deterministic for request_asset_upload_url
      // finalize (local stand-in for S3 presigned PUT). Also accepts PUT for source-shaped clients.
      server.middlewares.use('/upload', async (req, res) => {
        if (req.method !== 'POST' && req.method !== 'PUT') {
          sendError(res, 405, 'method not allowed — use POST or PUT');
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const name = url.searchParams.get('name') ?? 'file';
          const assetIdRaw = url.searchParams.get('assetId') ?? '';
          const assetId = assetIdRaw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
          const ext = (extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin');
          const buf = await readBody(req);
          if (buf.length === 0) { sendError(res, 400, 'empty body'); return; }
          await mkdir(UPLOAD_DIR, { recursive: true });
          const fname = assetId ? `${assetId}${ext}` : `${randomUUID()}${ext}`;
          await writeFile(join(UPLOAD_DIR, fname), buf);
          sendJson(res, 200, {
            path: `/media/uploads/${fname}`,
            bytes: buf.length,
            fileKey: `uploads/${fname}`,
            assetId: assetId || undefined,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[upload] ${message}`);
          if (!res.headersSent) sendError(res, 500, message);
          else res.end();
        }
      });

      server.middlewares.use('/api/import-url', async (req, res) => {
        if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
        try {
          const raw = await readBody(req, MAX_JSON_BYTES);
          const body = JSON.parse(raw.toString('utf8') || '{}') as { url?: string; name?: string };
          const remote = String(body.url ?? '').trim();
          if (!remote || !isHttpUrl(remote)) {
            sendError(res, 400, 'url must be a public http(s) URI');
            return;
          }
          const nameHint = typeof body.name === 'string' ? body.name.trim() : undefined;

          const r = await fetch(remote, {
            redirect: 'follow',
            signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
            headers: { 'User-Agent': 'chatcut-clone-import/1.0' },
          });
          if (!r.ok) {
            sendError(res, 200, `upstream HTTP ${r.status}`);
            return;
          }
          const contentType = r.headers.get('content-type');
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length === 0) {
            sendError(res, 400, 'upstream empty body');
            return;
          }
          if (buf.length > MAX_BODY_BYTES) {
            sendError(res, 413, 'file too large (>300MB)');
            return;
          }

          const ext = extFromUrlOrType(remote, contentType, nameHint);
          await mkdir(UPLOAD_DIR, { recursive: true });
          const fname = `${randomUUID()}${ext}`;
          await writeFile(join(UPLOAD_DIR, fname), buf);

          let filename = nameHint;
          if (!filename) {
            try {
              filename = decodeURIComponent(remote.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() ?? fname);
            } catch {
              filename = fname;
            }
          }

          sendJson(res, 200, {
            ok: true,
            path: `/media/uploads/${fname}`,
            bytes: buf.length,
            contentType: contentType ?? undefined,
            filename,
            sourceUrl: remote,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[import-url] ${message}`);
          if (!res.headersSent) sendJson(res, 200, { ok: false, error: message });
          else res.end();
        }
      });
    },
  };
}
