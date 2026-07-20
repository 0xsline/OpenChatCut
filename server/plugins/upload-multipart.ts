// Local multipart upload — stand-in for S3 CreateMultipartUpload / UploadPart / Complete.
// Browser (or agent) can retry individual parts without re-sending a multi-GB body.
//
//   POST /upload/multipart/init     JSON { name, size, assetId?, contentType? }
//   PUT  /upload/multipart/part?uploadId=&part=N   raw body
//   GET  /upload/multipart/status?uploadId=
//   POST /upload/multipart/complete JSON { uploadId }
//   DELETE /upload/multipart?uploadId=   abort
//
// Parts land under uploadDir()/.multipart/<id>/ ; complete concatenates → /media/uploads/<file>.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { putUploadFile, r2Config } from '../r2.ts';
import { uploadDir } from '../media-dir.ts';
import { maxUploadBytes } from './upload.ts';

const DEFAULT_PART_SIZE = 8 * 1024 * 1024; // 8 MiB
const MAX_PARTS = 10_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface MultipartMeta {
  uploadId: string;
  name: string;
  ext: string;
  assetId?: string;
  contentType?: string;
  size: number;
  partSize: number;
  partCount: number;
  createdAt: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function readJson(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function multipartRoot(): string {
  return join(uploadDir(), '.multipart');
}

function sessionDir(uploadId: string): string {
  return join(multipartRoot(), uploadId);
}

function isSafeUploadId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

async function loadMeta(uploadId: string): Promise<MultipartMeta | null> {
  const path = join(sessionDir(uploadId), 'meta.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as MultipartMeta;
  } catch {
    return null;
  }
}

async function saveMeta(meta: MultipartMeta): Promise<void> {
  const dir = sessionDir(meta.uploadId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
}

function partPath(uploadId: string, part: number): string {
  return join(sessionDir(uploadId), `part-${String(part).padStart(5, '0')}`);
}

// 磁盘上的 part 文件即收件记录。不能在 meta.json 里记 received:并发 part 请求
// 各自 load→改→save 整份 meta,后写的会用旧快照覆盖别人刚记的标记(读改写竞态,
// 大文件必现 missing parts 误报)。
async function receivedParts(uploadId: string): Promise<number[]> {
  const names = await readdir(sessionDir(uploadId)).catch(() => [] as string[]);
  return names
    .map((n) => /^part-(\d{5})$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

async function streamBodyToFile(
  req: IncomingMessage,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        cb(new Error(`part exceeds max ${maxBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, createWriteStream(destPath));
  } catch (err) {
    await unlink(destPath).catch(() => {});
    throw err;
  }
  return size;
}

async function concatParts(meta: MultipartMeta, destPath: string): Promise<number> {
  await unlink(destPath).catch(() => {});
  const out = createWriteStream(destPath);
  let total = 0;
  try {
    for (let p = 1; p <= meta.partCount; p += 1) {
      const pp = partPath(meta.uploadId, p);
      if (!existsSync(pp)) throw new Error(`missing part ${p}`);
      const info = await stat(pp);
      total += info.size;
      await pipeline(createReadStream(pp), out, { end: false });
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });
  } catch (err) {
    out.destroy();
    await unlink(destPath).catch(() => {});
    throw err;
  }
  return total;
}

/** Drop sessions older than TTL (best-effort, on init). */
async function gcStaleSessions(): Promise<void> {
  const root = multipartRoot();
  if (!existsSync(root)) return;
  const now = Date.now();
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!isSafeUploadId(name)) continue;
    const meta = await loadMeta(name);
    if (!meta || now - meta.createdAt > SESSION_TTL_MS) {
      await rm(sessionDir(name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function uploadMultipartPlugin(): Plugin {
  return {
    name: 'openchatcut-upload-multipart',
    configureServer(server) {
      // Must register before bare /upload (connect prefix match).
      server.middlewares.use('/upload/multipart/init', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }
        try {
          void gcStaleSessions();
          const body = (await readJson(req)) as {
            name?: string;
            size?: number;
            assetId?: string;
            contentType?: string;
            partSize?: number;
          };
          const name = String(body.name ?? 'file');
          const size = Number(body.size);
          if (!Number.isFinite(size) || size <= 0) {
            sendError(res, 400, 'size must be a positive number');
            return;
          }
          const max = maxUploadBytes();
          if (size > max) {
            sendError(res, 413, `file too large (max ${Math.round(max / (1024 ** 3))}GB)`);
            return;
          }
          let partSize = Number(body.partSize) || DEFAULT_PART_SIZE;
          partSize = Math.min(Math.max(partSize, 1024 * 1024), 64 * 1024 * 1024);
          let partCount = Math.ceil(size / partSize);
          if (partCount > MAX_PARTS) {
            partSize = Math.ceil(size / MAX_PARTS);
            partCount = Math.ceil(size / partSize);
          }
          const assetIdRaw = String(body.assetId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
          const ext = (extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin');
          const uploadId = randomUUID().replace(/-/g, '');
          const meta: MultipartMeta = {
            uploadId,
            name,
            ext,
            assetId: assetIdRaw || undefined,
            contentType: typeof body.contentType === 'string' ? body.contentType : undefined,
            size,
            partSize,
            partCount,
            createdAt: Date.now(),
          };
          await saveMeta(meta);
          sendJson(res, 200, {
            uploadId,
            partSize,
            partCount,
            size,
            maxBytes: max,
            assetId: meta.assetId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[multipart/init] ${message}`);
          sendError(res, 500, message);
        }
      });

      server.middlewares.use('/upload/multipart/part', async (req, res) => {
        if (req.method !== 'PUT' && req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use PUT or POST');
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const uploadId = url.searchParams.get('uploadId') ?? '';
          const part = Number(url.searchParams.get('part'));
          if (!isSafeUploadId(uploadId)) {
            sendError(res, 400, 'invalid uploadId');
            return;
          }
          const meta = await loadMeta(uploadId);
          if (!meta) {
            sendError(res, 404, 'upload session not found or expired');
            return;
          }
          if (!Number.isInteger(part) || part < 1 || part > meta.partCount) {
            sendError(res, 400, `part must be 1..${meta.partCount}`);
            return;
          }
          // Last part may be smaller; others should be full partSize (allow slightly less for edge).
          const maxPart = part === meta.partCount
            ? meta.partSize
            : meta.partSize;
          // Last part exact: size - (partCount-1)*partSize
          const expectedMax = part === meta.partCount
            ? meta.size - meta.partSize * (meta.partCount - 1)
            : meta.partSize;
          const dest = partPath(uploadId, part);
          await mkdir(sessionDir(uploadId), { recursive: true });
          const bytes = await streamBodyToFile(req, dest, maxPart + 1024);
          if (bytes === 0) {
            await unlink(dest).catch(() => {});
            sendError(res, 400, 'empty part body');
            return;
          }
          if (part === meta.partCount && bytes > expectedMax + 64) {
            // soft: still accept if slightly off due to encoding
          }
          const received = await receivedParts(uploadId);
          sendJson(res, 200, { ok: true, part, bytes, received: received.length, partCount: meta.partCount });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[multipart/part] ${message}`);
          if (!res.headersSent) sendError(res, 500, message);
          else res.end();
        }
      });

      server.middlewares.use('/upload/multipart/status', async (req, res) => {
        if (req.method !== 'GET') {
          sendError(res, 405, 'method not allowed — use GET');
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const uploadId = url.searchParams.get('uploadId') ?? '';
          if (!isSafeUploadId(uploadId)) {
            sendError(res, 400, 'invalid uploadId');
            return;
          }
          const meta = await loadMeta(uploadId);
          if (!meta) {
            sendError(res, 404, 'upload session not found or expired');
            return;
          }
          const received = await receivedParts(uploadId);
          sendJson(res, 200, {
            uploadId,
            partCount: meta.partCount,
            partSize: meta.partSize,
            size: meta.size,
            received,
            complete: received.length === meta.partCount,
          });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        }
      });

      server.middlewares.use('/upload/multipart/complete', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }
        try {
          const body = (await readJson(req)) as { uploadId?: string };
          const uploadId = String(body.uploadId ?? '');
          if (!isSafeUploadId(uploadId)) {
            sendError(res, 400, 'invalid uploadId');
            return;
          }
          const meta = await loadMeta(uploadId);
          if (!meta) {
            sendError(res, 404, 'upload session not found or expired');
            return;
          }
          const missing: number[] = [];
          for (let p = 1; p <= meta.partCount; p += 1) {
            if (!existsSync(partPath(uploadId, p))) missing.push(p);
          }
          if (missing.length) {
            sendError(res, 400, `missing parts: ${missing.slice(0, 20).join(',')}${missing.length > 20 ? '…' : ''}`);
            return;
          }

          const dir = uploadDir();
          await mkdir(dir, { recursive: true });
          const fname = meta.assetId ? `${meta.assetId}${meta.ext}` : `${randomUUID()}${meta.ext}`;
          const partOut = join(dir, `.${fname}.part`);
          const finalPath = join(dir, fname);
          const bytes = await concatParts(meta, partOut);
          if (bytes === 0) {
            await unlink(partOut).catch(() => {});
            sendError(res, 400, 'assembled empty file');
            return;
          }
          // Optional size check (allow 1% slack for odd clients)
          if (Math.abs(bytes - meta.size) > Math.max(1024, meta.size * 0.01)) {
            server.config.logger.info(`[multipart] size mismatch declared=${meta.size} got=${bytes}`);
          }
          await rename(partOut, finalPath);

          let cloud: 'ok' | 'off' | 'failed' = 'off';
          if (r2Config()) {
            try {
              await putUploadFile(fname, finalPath, meta.contentType);
              cloud = 'ok';
            } catch (err) {
              cloud = 'failed';
              server.config.logger.error(`[multipart→R2] ${fname}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          await rm(sessionDir(uploadId), { recursive: true, force: true }).catch(() => {});

          sendJson(res, 200, {
            path: `/media/uploads/${fname}`,
            bytes,
            fileKey: `uploads/${fname}`,
            assetId: meta.assetId,
            cloud,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[multipart/complete] ${message}`);
          sendError(res, 500, message);
        }
      });

      server.middlewares.use('/upload/multipart', async (req, res, next) => {
        // Only handle DELETE abort on exact /upload/multipart?uploadId=
        if (req.method !== 'DELETE') {
          next();
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const uploadId = url.searchParams.get('uploadId') ?? '';
          if (!isSafeUploadId(uploadId)) {
            sendError(res, 400, 'invalid uploadId');
            return;
          }
          await rm(sessionDir(uploadId), { recursive: true, force: true }).catch(() => {});
          sendJson(res, 200, { ok: true, aborted: uploadId });
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        }
      });
    },
  };
}
