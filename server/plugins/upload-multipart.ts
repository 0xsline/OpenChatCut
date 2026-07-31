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
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;
const DEFAULT_IDLE_TTL_MS = 2 * 60 * 60_000, DEFAULT_ABSOLUTE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_ACTIVE_GRACE_MS = 2 * 60_000, DEFAULT_GC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_ROUTE_GC_MS = 30_000;
function envLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function multipartLimits(): MultipartGcLimits {
  return {
    idleTtlMs: envLimit('UPLOAD_MULTIPART_IDLE_TTL_MS', DEFAULT_IDLE_TTL_MS),
    absoluteTtlMs: envLimit('UPLOAD_MULTIPART_ABSOLUTE_TTL_MS', DEFAULT_ABSOLUTE_TTL_MS),
    activeGraceMs: envLimit('UPLOAD_MULTIPART_ACTIVE_GRACE_MS', DEFAULT_ACTIVE_GRACE_MS),
    maxSessions: envLimit('UPLOAD_MULTIPART_MAX_SESSIONS', 32),
    maxBytes: envLimit('UPLOAD_MULTIPART_MAX_BYTES', maxUploadBytes() * 2),
  };
}
interface MultipartMeta {
  uploadId: string; name: string; ext: string; assetId?: string; contentType?: string;
  size: number; partSize: number; partCount: number; createdAt: number; updatedAt: number;
}
export interface MultipartGcLimits { idleTtlMs: number; absoluteTtlMs: number; activeGraceMs: number; maxSessions: number; maxBytes: number }
export interface MultipartSessionInfo { uploadId: string; createdAt: number; updatedAt: number; bytes: number; active?: boolean }
export function selectMultipartGcVictims(
  sessions: MultipartSessionInfo[],
  limits: MultipartGcLimits,
  now = Date.now(),
): Set<string> {
  const protectedSession = (session: MultipartSessionInfo) =>
    session.active === true || now - session.updatedAt < limits.activeGraceMs;
  const victims = new Set(sessions
    .filter((session) => !protectedSession(session)
      && (now - session.updatedAt >= limits.idleTtlMs
        || now - session.createdAt >= limits.absoluteTtlMs))
    .map((session) => session.uploadId));
  const kept = sessions.filter((session) => !victims.has(session.uploadId));
  let count = kept.length;
  let bytes = kept.reduce((total, session) => total + session.bytes, 0);
  for (const session of [...kept].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (count <= limits.maxSessions && bytes <= limits.maxBytes) break;
    if (protectedSession(session)) continue;
    victims.add(session.uploadId);
    count -= 1;
    bytes -= session.bytes;
  }
  return victims;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
}
function sendError(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { error: message }); }
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
function multipartRoot(): string { return join(uploadDir(), '.multipart'); }
function sessionDir(uploadId: string): string { return join(multipartRoot(), uploadId); }
function isSafeUploadId(id: string): boolean { return /^[a-zA-Z0-9_-]{8,80}$/.test(id); }
function parseMeta(raw: unknown, uploadId: string): MultipartMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<MultipartMeta>;
  const numbers = [value.size, value.partSize, value.partCount, value.createdAt];
  if (value.uploadId !== uploadId || typeof value.name !== 'string' || typeof value.ext !== 'string' || !/^\.[a-z0-9]{1,16}$/.test(value.ext)
    || !numbers.every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0)
    || (value.assetId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(value.assetId)) || (value.contentType !== undefined && (typeof value.contentType !== 'string' || value.contentType.length > 200)) || !Number.isInteger(Number(value.partCount)) || value.partCount! > MAX_PARTS
    || value.partCount !== Math.ceil(value.size! / value.partSize!)) return null;
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    ? value.updatedAt : value.createdAt;
  return { ...value, updatedAt } as MultipartMeta;
}
async function loadMeta(uploadId: string): Promise<MultipartMeta | null> {
  try {
    return parseMeta(JSON.parse(await readFile(join(sessionDir(uploadId), 'meta.json'), 'utf8')), uploadId);
  } catch {
    return null;
  }
}
async function saveMeta(meta: MultipartMeta): Promise<void> {
  const dir = sessionDir(meta.uploadId);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.meta-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(meta), 'utf8');
    await rename(tmp, join(dir, 'meta.json'));
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
function partPath(uploadId: string, part: number): string {
  return join(sessionDir(uploadId), `part-${String(part).padStart(5, '0')}`);
}
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
async function sessionBytes(uploadId: string): Promise<number> {
  const names = await readdir(sessionDir(uploadId)).catch(() => [] as string[]);
  let bytes = 0;
  for (const name of names) {
    if (!/^part-\d{5}$/.test(name)) continue;
    bytes += (await stat(join(sessionDir(uploadId), name)).catch(() => null))?.size ?? 0;
  }
  return bytes;
}
async function gcMultipartSessions(
  limits: MultipartGcLimits,
  active: ReadonlySet<string>,
): Promise<{ bytes: number; sessions: number }> {
  const names = await readdir(multipartRoot()).catch(() => [] as string[]);
  const rows: MultipartSessionInfo[] = [];
  for (const uploadId of names.filter(isSafeUploadId)) {
    const [meta, usage, dirInfo] = await Promise.all([
      loadMeta(uploadId), sessionBytes(uploadId), stat(sessionDir(uploadId)).catch(() => null),
    ]);
    rows.push({
      uploadId, bytes: meta?.size ?? usage, active: active.has(uploadId),
      createdAt: meta?.createdAt ?? 0, updatedAt: meta?.updatedAt ?? dirInfo?.mtimeMs ?? 0,
    });
  }
  const victims = selectMultipartGcVictims(rows, limits);
  const removed = new Set<string>();
  await Promise.all([...victims].map(async (id) => {
    try {
      await rm(sessionDir(id), { recursive: true, force: true });
      removed.add(id);
    } catch { /* keep it counted so admission remains bounded */ }
  }));
  const kept = rows.filter((row) => !removed.has(row.uploadId));
  return { bytes: kept.reduce((total, row) => total + row.bytes, 0), sessions: kept.length };
}
async function loadLiveMeta(uploadId: string, limits: MultipartGcLimits): Promise<MultipartMeta | null> {
  const meta = await loadMeta(uploadId);
  if (!meta) return null;
  const now = Date.now();
  if (now - meta.updatedAt >= limits.idleTtlMs || now - meta.createdAt >= limits.absoluteTtlMs) {
    await rm(sessionDir(uploadId), { recursive: true, force: true }).catch(() => {});
    return null;
  }
  const touched = { ...meta, updatedAt: now };
  await saveMeta(touched);
  return touched;
}
export function uploadMultipartPlugin(): Plugin {
  return {
    name: 'openchatcut-upload-multipart',
    configureServer(server) {
      const limits = multipartLimits();
      const active = new Set<string>();
      let lastGcAt = 0;
      let gcRun: Promise<{ bytes: number; sessions: number }> | null = null;
      let usage = { bytes: 0, sessions: 0 };
      let pendingBytes = 0, pendingSessions = 0;
      const runGc = (force = false) => {
        if (!force && Date.now() - lastGcAt < DEFAULT_ROUTE_GC_MS) return Promise.resolve(usage);
        if (!gcRun) {
          lastGcAt = Date.now();
          gcRun = gcMultipartSessions(limits, active)
            .then((next) => (usage = next))
            .finally(() => { gcRun = null; });
        }
        return gcRun;
      };
      void runGc(true);
      const gcTimer = setInterval(() => { void runGc(true); }, DEFAULT_GC_INTERVAL_MS);
      gcTimer.unref?.();
      server.httpServer?.once('close', () => clearInterval(gcTimer));
      server.middlewares.use('/upload/multipart/init', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }
        try {
          await runGc(true);
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
          if (size > limits.maxBytes || usage.sessions + pendingSessions >= limits.maxSessions
            || usage.bytes + pendingBytes + size > limits.maxBytes) {
            sendError(res, 429, 'multipart storage capacity is currently in use');
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
          const timestamp = Date.now();
          const meta: MultipartMeta = {
            uploadId, name, ext, size, partSize, partCount,
            assetId: assetIdRaw || undefined,
            contentType: typeof body.contentType === 'string' ? body.contentType : undefined,
            createdAt: timestamp, updatedAt: timestamp,
          };
          pendingBytes += size; pendingSessions += 1;
          try {
            await saveMeta(meta);
          } finally {
            pendingBytes -= size;
            pendingSessions -= 1;
          }
          usage = { bytes: usage.bytes + size, sessions: usage.sessions + 1 };
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
        let activeUploadId = '';
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const uploadId = url.searchParams.get('uploadId') ?? '';
          const part = Number(url.searchParams.get('part'));
          if (!isSafeUploadId(uploadId)) {
            sendError(res, 400, 'invalid uploadId');
            return;
          }
          activeUploadId = uploadId;
          active.add(uploadId);
          void runGc();
          const meta = await loadLiveMeta(uploadId, limits);
          if (!meta) {
            sendError(res, 404, 'upload session not found or expired');
            return;
          }
          if (!Number.isInteger(part) || part < 1 || part > meta.partCount) {
            sendError(res, 400, `part must be 1..${meta.partCount}`);
            return;
          }
          const expectedMax = part === meta.partCount
            ? meta.size - meta.partSize * (meta.partCount - 1)
            : meta.partSize;
          const dest = partPath(uploadId, part);
          const tmp = `${dest}.${randomUUID()}.tmp`;
          await mkdir(sessionDir(uploadId), { recursive: true });
          const bytes = await streamBodyToFile(req, tmp, expectedMax);
          if (bytes === 0) {
            await unlink(tmp).catch(() => {});
            sendError(res, 400, 'empty part body');
            return;
          }
          await rename(tmp, dest);
          const received = await receivedParts(uploadId);
          sendJson(res, 200, { ok: true, part, bytes, received: received.length, partCount: meta.partCount });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[multipart/part] ${message}`);
          if (!res.headersSent) sendError(res, 500, message);
          else res.end();
        } finally {
          if (activeUploadId) active.delete(activeUploadId);
        }
      });
      server.middlewares.use('/upload/multipart/status', async (req, res) => {
        if (req.method !== 'GET') {
          sendError(res, 405, 'method not allowed — use GET');
          return;
        }
        let activeUploadId = '';
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const uploadId = url.searchParams.get('uploadId') ?? '';
          if (!isSafeUploadId(uploadId)) {
            sendError(res, 400, 'invalid uploadId');
            return;
          }
          activeUploadId = uploadId;
          active.add(uploadId);
          void runGc();
          const meta = await loadLiveMeta(uploadId, limits);
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
        } finally {
          if (activeUploadId) active.delete(activeUploadId);
        }
      });
      server.middlewares.use('/upload/multipart/complete', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }
        let activeUploadId = '';
        try {
          const body = (await readJson(req)) as { uploadId?: string };
          const uploadId = String(body.uploadId ?? '');
          if (!isSafeUploadId(uploadId)) {
            sendError(res, 400, 'invalid uploadId');
            return;
          }
          activeUploadId = uploadId;
          active.add(uploadId);
          void runGc();
          const meta = await loadLiveMeta(uploadId, limits);
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
          usage = {
            bytes: Math.max(0, usage.bytes - meta.size),
            sessions: Math.max(0, usage.sessions - 1),
          };
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
        } finally {
          if (activeUploadId) active.delete(activeUploadId);
        }
      });
      server.middlewares.use('/upload/multipart', async (req, res, next) => {
        if (req.method !== 'DELETE') {
          next();
          return;
        }
        void runGc();
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
