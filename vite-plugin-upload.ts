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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('file too large (>300MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

/**
 * Dev-server plugin exposing `POST /upload?name=<filename>` with the raw file
 * bytes as the body → writes the file under public/media/uploads/ and returns
 * `{ path }` (a same-origin URL usable by both preview and export).
 */
export function uploadPlugin(): Plugin {
  return {
    name: 'chatcut-upload',
    configureServer(server) {
      server.middlewares.use('/upload', async (req, res) => {
        if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const name = url.searchParams.get('name') ?? 'file';
          const ext = (extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin');
          const buf = await readBody(req);
          if (buf.length === 0) { sendError(res, 400, 'empty body'); return; }
          await mkdir(UPLOAD_DIR, { recursive: true });
          const fname = `${randomUUID()}${ext}`;
          await writeFile(join(UPLOAD_DIR, fname), buf);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ path: `/media/uploads/${fname}`, bytes: buf.length }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[upload] ${message}`);
          if (!res.headersSent) sendError(res, 500, message);
          else res.end();
        }
      });
    },
  };
}
