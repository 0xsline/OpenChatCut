// Static hosting with built-in server: vite build product (dist/) + upload materials at runtime (/media/uploads,
// Decoupled from the build-time copy of dist - uploading occurs at runtime and must be read directly from uploadDir()).
// The media extension goes to serveDiskFile of server/media-dir (Range/206, required for video seek);
// The rest (js/css/html/fonts, etc.) complete MIME simple outflow - ES module is loaded with strict MIME check.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';
import { mimeFor, resolveUploadFile, serveDiskFile } from '../server/media-dir.ts';
import type { Middleware } from './mini-connect.ts';

const EXTRA_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', ico: 'image/x-icon', map: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', cube: 'text/plain; charset=utf-8', webmanifest: 'application/manifest+json',
};

export function staticMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return EXTRA_MIME[ext] ?? mimeFor(name);
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<boolean> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    size = info.size;
  } catch {
    return false;
  }
  // The media class extension is given to serveDiskFile (whose MIME table is overridden, with Range support)
  if (mimeFor(file) !== 'application/octet-stream') {
    await serveDiskFile(req, res, file);
    return true;
  }
  res.writeHead(200, { 'Content-Type': staticMime(file), 'Content-Length': String(size) });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

/** /media/uploads/<name> → uploadDir() Direct reading(not found next(),fall back dist of build issue copy)。 */
export function uploadsMiddleware(): Middleware {
  return async (req, res, next) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''));
    const file = resolveUploadFile(name);
    if (!file) { next(); return; }
    await serveDiskFile(req, res, file);
  };
}

/** dist/ static cover:Path crossing denied;Missed and like page path → index.html(hash routing)。 */
export function distStaticMiddleware(distDir: string): Middleware {
  const root = normalize(distDir);
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) { next(); return; }  // time travel
    if (await sendFile(req, res, file)) return;
    // SPA backs up: the path without extension returns to index.html; the rest is handed over to 404
    if (!/\.[a-z0-9]+$/i.test(rel) && await sendFile(req, res, join(root, 'index.html'))) return;
    next();
  };
}
