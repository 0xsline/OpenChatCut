import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  getUploadObjectToFile, presignGetUpload, presignPutUpload, putUploadFile,
  r2Config, r2PresignEnabled,
} from '../r2.ts';
import {
  DEFAULT_UPLOAD_DIR, isCustomUploadDir, isSafeUploadName, serveDiskFile,
  syncLegacyUploads, uploadDir,
} from '../media-dir.ts';
import { deleteMediaPreviewDerivatives } from './media-preview.ts';

const MAX_JSON_BYTES = 64 * 1024;
const IMPORT_TIMEOUT_MS = 30 * 60_000;
const MEDIA_AUTHORITY_HEADER = 'X-OpenChatCut-Media-Authority';
type Logger = ViteDevServer['config']['logger'];
type CloudState = 'ok' | 'off' | 'failed';

export function maxUploadBytes(): number {
  const raw = process.env.UPLOAD_MAX_BYTES?.trim();
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 10 * 1024 * 1024 * 1024;
}

class UploadTooLargeError extends Error {
  constructor(max: number) {
    super(`file too large (max ${formatBytes(max)})`);
    this.name = 'UploadTooLargeError';
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes % (1024 ** 3) === 0 ? 0 : 1)}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function readBody(req: IncomingMessage, max = MAX_JSON_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new UploadTooLargeError(max));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function streamToFile(
  source: Readable | NodeJS.ReadableStream,
  destination: string,
  maxBytes: number,
): Promise<number> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) { done(new UploadTooLargeError(maxBytes)); return; }
      done(null, chunk);
    },
  });
  try {
    await pipeline(source as Readable, counter, createWriteStream(destination));
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
  return size;
}

function contentLengthOf(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
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
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'audio/mpeg': '.mp3',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/ogg': '.ogg',
};

function extFromUrlOrType(url: string, contentType: string | null, hint?: string): string {
  if (hint) {
    const extension = extname(hint).toLowerCase().replace(/[^.a-z0-9]/g, '');
    if (extension) return extension;
  }
  const clean = url.split('?')[0].split('#')[0];
  const fromUrl = extname(clean).toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (fromUrl && fromUrl.length <= 6) return fromUrl;
  const base = contentType?.split(';')[0].trim().toLowerCase();
  return (base && CONTENT_TYPE_EXTENSIONS[base]) || '.bin';
}

function mediaName(req: IncomingMessage): string | null {
  try {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''));
    return isSafeUploadName(name) ? name : null;
  } catch {
    return null;
  }
}

function diskUpload(name: string): string | undefined {
  return [...new Set([uploadDir(), DEFAULT_UPLOAD_DIR])]
    .map((directory) => join(directory, name))
    .find((path) => existsSync(path));
}

async function serveR2Media(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
): Promise<void> {
  const directory = uploadDir();
  try {
    if (!r2Config()) { sendError(res, 404, `media not found: ${name}`); return; }
    await mkdir(directory, { recursive: true });
    const partPath = join(directory, `.${name}.part`);
    const finalPath = join(directory, name);
    const object = await getUploadObjectToFile(name, partPath);
    if (!object) {
      await unlink(partPath).catch(() => {});
      sendError(res, 404, `media not found: ${name}`);
      return;
    }
    await rename(partPath, finalPath);
    logger.info(`[R2 回源] ${name} (${object.bytes} bytes)`);
    res.setHeader(MEDIA_AUTHORITY_HEADER, 'server');
    await serveDiskFile(req, res, finalPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[R2 回源] ${name}: ${message}`);
    if (!res.headersSent) sendError(res, 502, `R2 read failed: ${message}`);
    else res.end();
  }
}

function handleMediaRead(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  logger: Logger,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
  const name = mediaName(req);
  if (!name) { next(); return; }
  const local = diskUpload(name);
  if (!local) { void serveR2Media(name, req, res, logger); return; }
  res.setHeader(MEDIA_AUTHORITY_HEADER, 'server');
  void serveDiskFile(req, res, local).catch((error: unknown) => {
    logger.error(`[media-dir] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) sendError(res, 500, 'media read failed');
    else res.end();
  });
}

async function handleUploadList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendError(res, 405, 'method not allowed — use GET'); return; }
  try {
    const directories = isCustomUploadDir() ? [uploadDir(), DEFAULT_UPLOAD_DIR] : [DEFAULT_UPLOAD_DIR];
    const seen = new Map<string, { name: string; bytes: number; mtimeMs: number }>();
    for (const directory of directories) {
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        if (!isSafeUploadName(name) || seen.has(name)) continue;
        const info = await stat(join(directory, name)).catch(() => null);
        if (info?.isFile()) seen.set(name, { name, bytes: info.size, mtimeMs: info.mtimeMs });
      }
    }
    sendJson(res, 200, { files: [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs) });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

function hydrateName(body: { name?: string; path?: string }): string {
  let name = String(body.name ?? '').trim();
  if (!name && body.path) {
    const match = String(body.path).match(/\/media\/uploads\/([^/?#]+)/);
    name = match?.[1] ? decodeURIComponent(match[1]) : '';
  }
  return name.replace(/^.*\//, '');
}

async function handleHydrate(req: IncomingMessage, res: ServerResponse, logger: Logger): Promise<void> {
  if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { name?: string; path?: string };
    const name = hydrateName(body);
    if (!isSafeUploadName(name)) { sendError(res, 400, 'unsafe or missing name'); return; }
    const directory = uploadDir();
    const finalPath = join(directory, name);
    if (existsSync(finalPath)) {
      const info = await stat(finalPath);
      sendJson(res, 200, { ok: true, path: `/media/uploads/${name}`, bytes: info.size, cached: true });
      return;
    }
    if (!r2Config()) { sendError(res, 404, `media not found locally and R2 is off: ${name}`); return; }
    await mkdir(directory, { recursive: true });
    const partPath = join(directory, `.${name}.part`);
    const object = await getUploadObjectToFile(name, partPath);
    if (!object) {
      await unlink(partPath).catch(() => {});
      sendError(res, 404, `R2 object not found: ${name}`);
      return;
    }
    await rename(partPath, finalPath);
    logger.info(`[upload/hydrate] ${name} (${object.bytes} bytes)`);
    sendJson(res, 200, { ok: true, path: `/media/uploads/${name}`, bytes: object.bytes, cached: false });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

async function handlePresignGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const name = (url.searchParams.get('name') ?? '').replace(/^.*\//, '');
  if (!isSafeUploadName(name)) { sendError(res, 400, 'unsafe or missing name'); return; }
  if (!r2PresignEnabled()) {
    sendJson(res, 200, {
      mode: 'proxy', downloadUrl: `/media/uploads/${name}`,
      path: `/media/uploads/${name}`, enabled: false,
    });
    return;
  }
  const signed = await presignGetUpload(name);
  if (!signed) { sendError(res, 503, 'presign unavailable'); return; }
  sendJson(res, 200, {
    mode: 'presign', enabled: true, downloadUrl: signed.downloadUrl,
    path: `/media/uploads/${name}`, fileKey: signed.fileKey, expiresIn: signed.expiresIn,
  });
}

function uploadSlot(body: { name?: string; assetId?: string; contentType?: string }) {
  const original = String(body.name ?? 'file');
  const assetId = String(body.assetId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const extension = extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  const base = assetId || randomUUID();
  const candidate = `${base}${extension}`;
  return {
    base,
    name: isSafeUploadName(candidate) ? candidate : `${randomUUID()}${extension}`,
    contentType: typeof body.contentType === 'string' && body.contentType
      ? body.contentType : 'application/octet-stream',
  };
}

async function handlePresignPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as {
    name?: string; assetId?: string; contentType?: string;
  };
  const slot = uploadSlot(body);
  const proxyUrl = `/upload?name=${encodeURIComponent(slot.name)}&assetId=${encodeURIComponent(slot.base)}`;
  if (r2PresignEnabled()) {
    const signed = await presignPutUpload(slot.name, slot.contentType);
    if (signed) {
      sendJson(res, 200, {
        ...signed, enabled: true, contentType: slot.contentType,
        name: slot.name, proxyUploadUrl: proxyUrl,
      });
      return;
    }
  }
  sendJson(res, 200, {
    mode: 'proxy', enabled: false, uploadUrl: proxyUrl,
    path: `/media/uploads/${slot.name}`, fileKey: `uploads/${slot.name}`,
    contentType: slot.contentType, name: slot.name, expiresIn: 0,
  });
}

async function handlePresign(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'GET') { await handlePresignGet(req, res); return; }
    if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use GET or POST'); return; }
    await handlePresignPost(req, res);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

async function mirrorUpload(
  name: string,
  path: string,
  contentType: string | undefined,
  logger: Logger,
  label: string,
): Promise<CloudState> {
  if (!r2Config()) return 'off';
  try {
    await putUploadFile(name, path, contentType);
    return 'ok';
  } catch (error) {
    logger.error(`[${label}] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

async function handleDeleteUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
    if (!isSafeUploadName(name)) { sendError(res, 400, 'unsafe or missing name'); return; }
    let removed = 0;
    for (const directory of [uploadDir(), DEFAULT_UPLOAD_DIR]) {
      try { await unlink(join(directory, name)); removed += 1; } catch { /* absent */ }
    }
    const derivativesRemoved = await deleteMediaPreviewDerivatives(name);
    sendJson(res, 200, { ok: true, removed, derivativesRemoved });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

function rejectDeclaredSize(req: IncomingMessage, res: ServerResponse, maxBytes: number): boolean {
  const declared = contentLengthOf(req);
  if (declared != null && declared > maxBytes) {
    sendError(res, 413, new UploadTooLargeError(maxBytes).message);
    req.resume();
    return true;
  }
  if (declared === 0) {
    sendError(res, 400, 'empty body');
    req.resume();
    return true;
  }
  return false;
}

async function handleUploadWrite(req: IncomingMessage, res: ServerResponse, logger: Logger): Promise<void> {
  const maxBytes = maxUploadBytes();
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const original = url.searchParams.get('name') ?? 'file';
    const assetId = (url.searchParams.get('assetId') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const extension = extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    if (rejectDeclaredSize(req, res, maxBytes)) return;
    const directory = uploadDir();
    await mkdir(directory, { recursive: true });
    const name = assetId ? `${assetId}${extension}` : `${randomUUID()}${extension}`;
    const partPath = join(directory, `.${name}.part`);
    const finalPath = join(directory, name);
    const bytes = await streamToFile(req, partPath, maxBytes);
    if (bytes === 0) {
      await unlink(partPath).catch(() => {});
      sendError(res, 400, 'empty body');
      return;
    }
    await rename(partPath, finalPath);
    const cloud = await mirrorUpload(name, finalPath, req.headers['content-type'] || undefined, logger, 'upload→R2');
    sendJson(res, 200, {
      path: `/media/uploads/${name}`, bytes, fileKey: `uploads/${name}`,
      assetId: assetId || undefined, cloud,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[upload] ${message}`);
    if (!res.headersSent) sendError(res, error instanceof UploadTooLargeError ? 413 : 500, message);
    else res.end();
  }
}

async function handleUpload(req: IncomingMessage, res: ServerResponse, logger: Logger): Promise<void> {
  if (req.method === 'DELETE') { await handleDeleteUpload(req, res); return; }
  if (req.method !== 'POST' && req.method !== 'PUT') {
    sendError(res, 405, 'method not allowed — use POST, PUT or DELETE');
    return;
  }
  await handleUploadWrite(req, res, logger);
}

interface RemoteImport {
  response: Response;
  remote: string;
  nameHint?: string;
  contentType: string | null;
}

async function fetchRemoteImport(
  body: { url?: string; name?: string },
  maxBytes: number,
  res: ServerResponse,
): Promise<RemoteImport | null> {
  const remote = String(body.url ?? '').trim();
  if (!remote || !isHttpUrl(remote)) { sendError(res, 400, 'url must be a public http(s) URI'); return null; }
  const nameHint = typeof body.name === 'string' ? body.name.trim() : undefined;
  const response = await fetch(remote, {
    redirect: 'follow', signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    headers: { 'User-Agent': 'openchatcut-import/1.0' },
  });
  if (!response.ok) { sendError(res, 200, `upstream HTTP ${response.status}`); return null; }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    sendError(res, 413, new UploadTooLargeError(maxBytes).message);
    return null;
  }
  if (!response.body) { sendError(res, 400, 'upstream empty body'); return null; }
  return { response, remote, nameHint, contentType: response.headers.get('content-type') };
}
async function saveRemoteImport(imported: RemoteImport, maxBytes: number, logger: Logger, res: ServerResponse) {
  const extension = extFromUrlOrType(imported.remote, imported.contentType, imported.nameHint);
  const directory = uploadDir();
  await mkdir(directory, { recursive: true });
  const name = `${randomUUID()}${extension}`;
  const partPath = join(directory, `.${name}.part`);
  const finalPath = join(directory, name);
  const body = Readable.fromWeb(imported.response.body as WebReadableStream);
  const bytes = await streamToFile(body, partPath, maxBytes);
  if (bytes === 0) {
    await unlink(partPath).catch(() => {});
    sendError(res, 400, 'upstream empty body'); return null;
  }
  await rename(partPath, finalPath);
  await mirrorUpload(name, finalPath, imported.contentType ?? undefined, logger, 'import-url→R2');
  return { name, bytes };
}

function importedFilename(imported: RemoteImport, fallback: string): string {
  if (imported.nameHint) return imported.nameHint;
  try {
    return decodeURIComponent(imported.remote.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() ?? fallback);
  } catch {
    return fallback;
  }
}

async function handleImportUrl(req: IncomingMessage, res: ServerResponse, logger: Logger): Promise<void> {
  if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
  const maxBytes = maxUploadBytes();
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { url?: string; name?: string };
    const imported = await fetchRemoteImport(body, maxBytes, res);
    if (!imported) return;
    const saved = await saveRemoteImport(imported, maxBytes, logger, res);
    if (!saved) return;
    sendJson(res, 200, {
      ok: true, path: `/media/uploads/${saved.name}`, bytes: saved.bytes,
      contentType: imported.contentType ?? undefined,
      filename: importedFilename(imported, saved.name), sourceUrl: imported.remote,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[import-url] ${message}`);
    if (!res.headersSent) {
      if (error instanceof UploadTooLargeError) sendError(res, 413, message);
      else sendJson(res, 200, { ok: false, error: message });
    } else res.end();
  }
}

export function registerUploadRoutes(server: ViteDevServer): void {
  const logger = server.config.logger;
  void syncLegacyUploads((message) => logger.info(message));
  server.middlewares.use('/media/uploads', (req, res, next) => handleMediaRead(req, res, next, logger));
  server.middlewares.use('/upload/list', handleUploadList);
  server.middlewares.use('/upload/hydrate', (req, res) => handleHydrate(req, res, logger));
  server.middlewares.use('/upload/presign', handlePresign);
  server.middlewares.use('/upload', (req, res) => handleUpload(req, res, logger));
  server.middlewares.use('/api/import-url', (req, res) => handleImportUrl(req, res, logger));
}
