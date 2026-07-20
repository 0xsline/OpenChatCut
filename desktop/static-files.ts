// 内嵌 server 的静态托管:vite build 产物(dist/)+ 运行时上传素材(/media/uploads,
// 与 dist 的 build 期拷贝解耦——上传发生在运行时,必须直读 uploadDir())。
// 媒体扩展名走 server/media-dir 的 serveDiskFile(Range/206,视频 seek 必需);
// 其余(js/css/html/字体等)补齐 MIME 简单流出——ES module 加载有严格 MIME 检查。
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
  // 媒体类扩展名交给 serveDiskFile(其 MIME 表已覆盖,并带 Range 支持)
  if (mimeFor(file) !== 'application/octet-stream') {
    await serveDiskFile(req, res, file);
    return true;
  }
  res.writeHead(200, { 'Content-Type': staticMime(file), 'Content-Length': String(size) });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

/** /media/uploads/<name> → uploadDir() 直读(找不到 next(),落回 dist 的 build 期拷贝)。 */
export function uploadsMiddleware(): Middleware {
  return async (req, res, next) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''));
    const file = resolveUploadFile(name);
    if (!file) { next(); return; }
    await serveDiskFile(req, res, file);
  };
}

/** dist/ 静态兜底:路径穿越拒绝;未命中且像页面路径 → index.html(hash 路由)。 */
export function distStaticMiddleware(distDir: string): Middleware {
  const root = normalize(distDir);
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) { next(); return; }  // 穿越
    if (await sendFile(req, res, file)) return;
    // SPA 兜底:无扩展名的路径回 index.html;其余交给 404
    if (!/\.[a-z0-9]+$/i.test(rel) && await sendFile(req, res, join(root, 'index.html'))) return;
    next();
  };
}
