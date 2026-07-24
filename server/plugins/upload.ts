import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  putUploadFile, getUploadObjectToFile, r2Config, r2PresignEnabled,
  presignPutUpload, presignGetUpload,
} from '../r2.ts';
import {
  DEFAULT_UPLOAD_DIR, isCustomUploadDir, isSafeUploadName, serveDiskFile, syncLegacyUploads, uploadDir,
} from '../media-dir.ts';

// Imported media is written to uploadDir() (default public/media/uploads/, MEDIA_DIR
// overridable) so the SAME URL path resolves in the Player preview AND the headless
// export (render.mjs symlinks the live dir into the bundle root). This is the local
// stand-in for S3 ingest.
// After configuring R2, upgrade to "write-through + back-to-origin": the disk becomes cache, R2 is the real source; the src path remains unchanged.
//
// Large files (local first):
// - The default upper limit is 10GB (can be overridden with UPLOAD_MAX_BYTES); Content-Length exceeds the limit directly to 413
// - POST /upload stream writes .part and then renames it to prevent the entire file from entering the Node heap
// - R2 write-through/back-to-source also uses file flow

/** Default 10GiB — local NLE; override with UPLOAD_MAX_BYTES (integer bytes). */
export function maxUploadBytes(): number {
  const raw = process.env.UPLOAD_MAX_BYTES?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 10 * 1024 * 1024 * 1024;
}

const MAX_JSON_BYTES = 64 * 1024;
const IMPORT_TIMEOUT_MS = 30 * 60_000; // remote pull can be large; 30min

class UploadTooLargeError extends Error {
  constructor(max: number) {
    super(`file too large (max ${formatBytes(max)})`);
    this.name = 'UploadTooLargeError';
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n % (1024 ** 3) === 0 ? 0 : 1)}GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function readBody(req: IncomingMessage, max = MAX_JSON_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new UploadTooLargeError(max));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Stream any readable into destPath with a hard byte cap. Returns bytes written. */
async function streamToFile(
  source: Readable | NodeJS.ReadableStream,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        cb(new UploadTooLargeError(maxBytes));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source as Readable, counter, createWriteStream(destPath));
  } catch (err) {
    await unlink(destPath).catch(() => {});
    throw err;
  }
  return size;
}

function contentLengthOf(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
 * - POST /upload?name=…  raw body → uploadDir()(Default public/media/uploads）
 * - POST /api/import-url  JSON {url, name?} → server-side fetch remote media → uploads
 *   (local adapter for download_media / push_asset ingestion)
 */
export function uploadPlugin(): Plugin {
  return {
    name: 'openchatcut-upload',
    configureServer(server) {
      // When the custom directory is enabled, the old materials in the default directory are copied in one direction (idempotent), and the single directory of the rendered symlink can see all.
      void syncLegacyUploads((msg) => server.config.logger.info(msg));

      // GET/HEAD /media/uploads/<name> Reading chain:
      //   Disk hit (custom directory ∪ default public/media/uploads) → serveDiskFile(Range)
      //   Both are missing + R2 → Return to source and place the order before serving.
      //   Otherwise, explicit 404 (Vite SPA is prohibited). False 200 - If the .voice.m4a just written is handed over to Vite
      //   Static will have a short cache miss → HTML 682B, playback/detection will fail immediately after isolating).
      server.middlewares.use('/media/uploads', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
        // The URL is decoded first (Chinese and other names are percent encoded), and then the single-segment safe name is determined;
        // Decoding failure or unsafe return to the default pipeline (to prevent directory traversal).
        let raw = '';
        try {
          raw = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''));
        } catch { next(); return; }
        if (!isSafeUploadName(raw)) { next(); return; }
        const dir = uploadDir();
        // Prefer live disk over Vite static — covers custom MEDIA_DIR and default dir
        // (just-written uploads / isolate-voice outputs are always readable immediately).
        const diskHit = [dir, DEFAULT_UPLOAD_DIR]
          .filter((d, i, arr) => arr.indexOf(d) === i)
          .map((d) => join(d, raw))
          .find((p) => existsSync(p));
        if (diskHit) {
          void serveDiskFile(req, res, diskHit).catch((err: unknown) => {
            server.config.logger.error(`[media-dir] ${raw}: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) sendError(res, 500, 'media read failed');
            else res.end();
          });
          return;
        }
        void (async () => {
          try {
            if (!r2Config()) { sendError(res, 404, `media not found: ${raw}`); return; }
            await mkdir(dir, { recursive: true });
            const partPath = join(dir, `.${raw}.part`);
            const finalPath = join(dir, raw);
            const obj = await getUploadObjectToFile(raw, partPath);
            if (!obj) {
              await unlink(partPath).catch(() => {});
              sendError(res, 404, `media not found: ${raw}`);
              return;
            }
            await rename(partPath, finalPath);
            server.config.logger.info(`[R2 Return to the source] ${raw} (${obj.bytes} bytes)`);
            await serveDiskFile(req, res, finalPath);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            server.config.logger.error(`[R2 Return to the source] ${raw}: ${message}`);
            if (!res.headersSent) sendError(res, 502, `R2 read failed: ${message}`);
            else res.end();
          }
        })();
      });

      // GET /upload/list → Upload directory disk list (custom directory ∪ old default directory, deduplication by name).
      // The "Clean Materials" panel uses it to compare with the full project reference set. Must be registered before /upload (connect prefix matches).
      server.middlewares.use('/upload/list', async (req, res) => {
        if (req.method !== 'GET') { sendError(res, 405, 'method not allowed — use GET'); return; }
        try {
          const dirs = isCustomUploadDir() ? [uploadDir(), DEFAULT_UPLOAD_DIR] : [DEFAULT_UPLOAD_DIR];
          const seen = new Map<string, { name: string; bytes: number; mtimeMs: number }>();
          for (const dir of dirs) {
            const names = await readdir(dir).catch(() => [] as string[]);
            for (const name of names) {
              if (!isSafeUploadName(name) || seen.has(name)) continue;
              try {
                const info = await stat(join(dir, name));
                if (info.isFile()) seen.set(name, { name, bytes: info.size, mtimeMs: info.mtimeMs });
              } catch { /* Race to delete, etc.,skip */ }
            }
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ files: [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs) }));
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        }
      });

      // POST /upload/hydrate  { name } — after browser presigned PUT to R2, pull object
      // into local uploadDir so extract-audio / ffmpeg / Player share the same path.
      server.middlewares.use('/upload/hydrate', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }
        try {
          const raw = await readBody(req, MAX_JSON_BYTES);
          const body = JSON.parse(raw.toString('utf8') || '{}') as { name?: string; path?: string };
          let name = String(body.name ?? '').trim();
          if (!name && body.path) {
            const m = String(body.path).match(/\/media\/uploads\/([^/?#]+)/);
            name = m?.[1] ? decodeURIComponent(m[1]) : '';
          }
          name = name.replace(/^.*\//, '');
          if (!isSafeUploadName(name)) {
            sendError(res, 400, 'unsafe or missing name');
            return;
          }
          const dir = uploadDir();
          const finalPath = join(dir, name);
          if (existsSync(finalPath)) {
            const info = await stat(finalPath);
            sendJson(res, 200, {
              ok: true,
              path: `/media/uploads/${name}`,
              bytes: info.size,
              cached: true,
            });
            return;
          }
          if (!r2Config()) {
            sendError(res, 404, `media not found locally and R2 is off: ${name}`);
            return;
          }
          await mkdir(dir, { recursive: true });
          const partPath = join(dir, `.${name}.part`);
          const obj = await getUploadObjectToFile(name, partPath);
          if (!obj) {
            await unlink(partPath).catch(() => {});
            sendError(res, 404, `R2 object not found: ${name}`);
            return;
          }
          await rename(partPath, finalPath);
          server.config.logger.info(`[upload/hydrate] ${name} (${obj.bytes} bytes)`);
          sendJson(res, 200, {
            ok: true,
            path: `/media/uploads/${name}`,
            bytes: obj.bytes,
            cached: false,
          });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        }
      });

      // POST /upload/presign  { name, contentType?, assetId? }
      // → R2 presigned PUT when configured (request_asset_upload_url response shape),
      //   else { mode:'proxy', uploadUrl:'/upload?…' } so the client always has a path.
      // GET  /upload/presign?name=… → presigned GET for private-bucket download.
      // After browser PUT to R2, client should POST /upload/hydrate to fill local cache.
      server.middlewares.use('/upload/presign', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const name = (url.searchParams.get('name') ?? '').replace(/^.*\//, '');
            if (!isSafeUploadName(name)) {
              sendError(res, 400, 'unsafe or missing name');
              return;
            }
            if (!r2PresignEnabled()) {
              sendJson(res, 200, {
                mode: 'proxy',
                downloadUrl: `/media/uploads/${name}`,
                path: `/media/uploads/${name}`,
                enabled: false,
              });
              return;
            }
            const signed = await presignGetUpload(name);
            if (!signed) {
              sendError(res, 503, 'presign unavailable');
              return;
            }
            sendJson(res, 200, {
              mode: 'presign',
              enabled: true,
              downloadUrl: signed.downloadUrl,
              path: `/media/uploads/${name}`,
              fileKey: signed.fileKey,
              expiresIn: signed.expiresIn,
            });
            return;
          }
          if (req.method !== 'POST') {
            sendError(res, 405, 'method not allowed — use GET or POST');
            return;
          }
          const raw = await readBody(req, MAX_JSON_BYTES);
          const body = (JSON.parse(raw.toString('utf8') || '{}') as {
            name?: string;
            assetId?: string;
            contentType?: string;
          });
          const nameRaw = String(body.name ?? 'file');
          const assetIdRaw = String(body.assetId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
          const ext = (extname(nameRaw).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin');
          const base = assetIdRaw || randomUUID();
          const fname = isSafeUploadName(`${base}${ext}`) ? `${base}${ext}` : `${randomUUID()}${ext}`;
          const contentType = typeof body.contentType === 'string' && body.contentType
            ? body.contentType
            : 'application/octet-stream';

          if (r2PresignEnabled()) {
            const signed = await presignPutUpload(fname, contentType);
            if (signed) {
              sendJson(res, 200, {
                ...signed,
                enabled: true,
                contentType,
                name: fname,
                // Client may still POST bytes to this proxy as CORS fallback.
                proxyUploadUrl: `/upload?name=${encodeURIComponent(fname)}&assetId=${encodeURIComponent(base)}`,
              });
              return;
            }
          }
          // Proxy mode — same-origin stream upload (default when R2 off or R2_PRESIGN=0).
          sendJson(res, 200, {
            mode: 'proxy',
            enabled: false,
            uploadUrl: `/upload?name=${encodeURIComponent(fname)}&assetId=${encodeURIComponent(base)}`,
            path: `/media/uploads/${fname}`,
            fileKey: `uploads/${fname}`,
            contentType,
            name: fname,
            expiresIn: 0,
          });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        }
      });

      // POST /upload?name=…&assetId=…  raw body → uploadDir()
      // Optional assetId makes the path deterministic for request_asset_upload_url
      // Finalize the local upload. PUT is accepted alongside POST.
      // DELETE /upload?name=… → Delete an uploaded file (clear both directories; single segment security name)——
      // Used for cascading project deletion/cleaning up unowned materials. R2 Cloud objects are intentionally not moved (can still be retrieved from the source, local deletion = reversible).
      server.middlewares.use('/upload', async (req, res) => {
        if (req.method === 'DELETE') {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const name = url.searchParams.get('name') ?? '';
            if (!isSafeUploadName(name)) { sendError(res, 400, 'unsafe or missing name'); return; }
            let removed = 0;
            for (const dir of [uploadDir(), DEFAULT_UPLOAD_DIR]) {
              try { await unlink(join(dir, name)); removed += 1; } catch { /* ENOENT Wait */ }
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, removed }));
          } catch (err) {
            sendError(res, 500, err instanceof Error ? err.message : String(err));
          }
          return;
        }
        if (req.method !== 'POST' && req.method !== 'PUT') {
          sendError(res, 405, 'method not allowed — use POST, PUT or DELETE');
          return;
        }
        const maxBytes = maxUploadBytes();
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const name = url.searchParams.get('name') ?? 'file';
          const assetIdRaw = url.searchParams.get('assetId') ?? '';
          const assetId = assetIdRaw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
          const ext = (extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin');

          const declared = contentLengthOf(req);
          if (declared != null && declared > maxBytes) {
            sendError(res, 413, new UploadTooLargeError(maxBytes).message);
            req.resume();
            return;
          }
          if (declared === 0) {
            sendError(res, 400, 'empty body');
            req.resume();
            return;
          }

          const dir = uploadDir();
          await mkdir(dir, { recursive: true });
          const fname = assetId ? `${assetId}${ext}` : `${randomUUID()}${ext}`;
          // Atomic publish: write to a hidden .part then rename, so a concurrent render
          // (whose bundle symlinks this dir) can never read a half-written file.
          const partPath = join(dir, `.${fname}.part`);
          const finalPath = join(dir, fname);
          const bytes = await streamToFile(req, partPath, maxBytes);
          if (bytes === 0) {
            await unlink(partPath).catch(() => {});
            sendError(res, 400, 'empty body');
            return;
          }
          await rename(partPath, finalPath);

          // Write through R2 (local disk has been downloaded, the cloud will not block the upload if it fails - log and respond to the response mark). Streaming disk reading without reloading memory.
          let cloud: 'ok' | 'off' | 'failed' = 'off';
          if (r2Config()) {
            try {
              await putUploadFile(fname, finalPath, req.headers['content-type'] || undefined);
              cloud = 'ok';
            } catch (err) {
              cloud = 'failed';
              server.config.logger.error(`[upload→R2] ${fname}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          sendJson(res, 200, {
            path: `/media/uploads/${fname}`,
            bytes,
            fileKey: `uploads/${fname}`,
            assetId: assetId || undefined,
            cloud,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[upload] ${message}`);
          if (!res.headersSent) {
            const status = err instanceof UploadTooLargeError ? 413 : 500;
            sendError(res, status, message);
          } else res.end();
        }
      });

      server.middlewares.use('/api/import-url', async (req, res) => {
        if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
        const maxBytes = maxUploadBytes();
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
            headers: { 'User-Agent': 'openchatcut-import/1.0' },
          });
          if (!r.ok) {
            sendError(res, 200, `upstream HTTP ${r.status}`);
            return;
          }
          const contentType = r.headers.get('content-type');
          const declared = Number(r.headers.get('content-length') ?? '');
          if (Number.isFinite(declared) && declared > maxBytes) {
            sendError(res, 413, new UploadTooLargeError(maxBytes).message);
            return;
          }
          if (!r.body) {
            sendError(res, 400, 'upstream empty body');
            return;
          }

          const ext = extFromUrlOrType(remote, contentType, nameHint);
          const dir = uploadDir();
          await mkdir(dir, { recursive: true });
          const fname = `${randomUUID()}${ext}`;
          const partPath = join(dir, `.${fname}.part`);
          const finalPath = join(dir, fname);
          // web ReadableStream → Node Readable (Node 18+)
          const nodeBody = Readable.fromWeb(r.body as import('stream/web').ReadableStream);
          const bytes = await streamToFile(nodeBody, partPath, maxBytes);
          if (bytes === 0) {
            await unlink(partPath).catch(() => {});
            sendError(res, 400, 'upstream empty body');
            return;
          }
          await rename(partPath, finalPath);

          if (r2Config()) {
            try { await putUploadFile(fname, finalPath, contentType ?? undefined); }
            catch (err) { server.config.logger.error(`[import-url→R2] ${fname}: ${err instanceof Error ? err.message : String(err)}`); }
          }

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
            bytes,
            contentType: contentType ?? undefined,
            filename,
            sourceUrl: remote,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[import-url] ${message}`);
          if (!res.headersSent) {
            if (err instanceof UploadTooLargeError) sendError(res, 413, message);
            else sendJson(res, 200, { ok: false, error: message });
          } else res.end();
        }
      });
    },
  };
}
