// Product-bundled static files live under repo `assets/` (fonts, SFX, thumbs, …).
// User/runtime media stays under `public/media/uploads/` (or MEDIA_DIR).
// URL paths stay root-absolute (`/fonts/...`, `/thumbnails/...`) — only the disk layout changed.
import { cpSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { mimeFor } from './media-dir.ts';

export const PRODUCT_ASSETS_DIR = resolve(process.cwd(), 'assets');

const EXTRA_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  map: 'application/json',
  json: 'application/json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  cube: 'text/plain; charset=utf-8',
};

function contentType(file: string): string {
  const media = mimeFor(file);
  if (media !== 'application/octet-stream') return media;
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return EXTRA_MIME[ext] ?? 'application/octet-stream';
}

/** Resolve a URL path to a file under assets/. Rejects path traversal. */
export function resolveProductAsset(urlPath: string): string | null {
  const clean = decodeURIComponent((urlPath.split('?')[0] ?? '').replace(/^\/+/, ''));
  if (!clean || clean.includes('\0')) return null;
  // User uploads are never product assets
  if (clean === 'media/uploads' || clean.startsWith('media/uploads/')) return null;
  const root = PRODUCT_ASSETS_DIR;
  const file = resolve(root, clean);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (file !== root && !file.startsWith(prefix)) return null;
  if (!existsSync(file)) return null;
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

export async function sendProductAsset(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
): Promise<void> {
  const st = statSync(file);
  const type = contentType(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
    stream.pipe(res);
  });
}

/** Copy product assets into a build/serve root (dist or remotion serveUrl). */
export function copyProductAssetsTo(destRoot: string): void {
  if (!existsSync(PRODUCT_ASSETS_DIR)) return;
  mkdirSync(destRoot, { recursive: true });
  cpSync(PRODUCT_ASSETS_DIR, destRoot, { recursive: true });
}

/**
 * Vite: serve `assets/` at site root in dev; copy into `dist/` on build.
 * `public/` only holds user runtime files (`media/uploads`).
 */
export function productAssetsPlugin(): Plugin {
  return {
    name: 'openchatcut-product-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            next();
            return;
          }
          const url = req.url ?? '';
          // Leave Vite internals / API / user uploads alone
          if (
            url.startsWith('/@')
            || url.startsWith('/node_modules')
            || url.startsWith('/src/')
            || url.startsWith('/media/uploads')
            || url.startsWith('/api')
            || url.startsWith('/llm')
            || url.startsWith('/assemblyai')
            || url.startsWith('/e2b')
            || url.startsWith('/upload')
            || url.startsWith('/export')
            || url.startsWith('/generate')
            || url.startsWith('/jobs')
          ) {
            next();
            return;
          }
          const file = resolveProductAsset(url);
          if (!file) {
            next();
            return;
          }
          await sendProductAsset(req, res, file);
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      const dist = resolve(process.cwd(), 'dist');
      if (!existsSync(dist)) return;
      copyProductAssetsTo(dist);
    },
  };
}
