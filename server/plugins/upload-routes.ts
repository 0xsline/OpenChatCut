import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  presignGetUpload, presignPutUpload, r2Config, r2PresignEnabled, UploadTooLargeError,
} from '../r2.ts';
import {
  isSafeUploadName, resolveOrHydrateUploadFile, serveDiskFile, syncLegacyUploads,
  uploadReadDirs,
} from '../media-dir.ts';
import { isIsolatedDevProfile } from '../runtime-profile.ts';
import { listMediaReferences } from '../media-references.ts';
import { sha256File } from '../../shared/node-content-hash.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import {
  directR2UploadAllowed, mediaName, readBody, sendError, sendJson,
} from './upload-route-http.ts';
import { diskUpload } from './upload-route-storage.ts';
import { handleImportUrl, handleUpload } from './upload-route-write.ts';

export { directR2UploadAllowed, maxUploadBytes } from './upload-route-http.ts';

const MEDIA_AUTHORITY_HEADER = 'X-OpenChatCut-Media-Authority';
type Logger = ViteDevServer['config']['logger'];

export interface UploadRouteDependencies {
  resolveUpload: typeof resolveOrHydrateUploadFile;
  syncLegacy: typeof syncLegacyUploads;
}

const defaultUploadRouteDependencies: UploadRouteDependencies = {
  resolveUpload: resolveOrHydrateUploadFile,
  syncLegacy: syncLegacyUploads,
};



async function serveR2Media(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  dependencies: UploadRouteDependencies,
): Promise<void> {
  try {
    const resolved = await dependencies.resolveUpload(name);
    if (!resolved) {
      sendError(res, 404, `media not found: ${name}`);
      return;
    }
    if (!resolved.cached) logger.info(`[R2 回源] ${name} (${resolved.bytes} bytes)`);
    res.setHeader(MEDIA_AUTHORITY_HEADER, 'server');
    await serveDiskFile(req, res, resolved.file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[R2 回源] ${name}: ${message}`);
    if (!res.headersSent) {
      if (error instanceof UploadTooLargeError) sendError(res, 413, message);
      else sendError(res, 502, `R2 read failed: ${message}`);
    } else res.end();
  }
}

function handleMediaRead(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  logger: Logger,
  dependencies: UploadRouteDependencies,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
  const name = mediaName(req);
  if (!name) {
    if (isIsolatedDevProfile()) sendError(res, 404, 'media not found');
    else next();
    return;
  }
  const local = diskUpload(name);
  if (!local) { void serveR2Media(name, req, res, logger, dependencies); return; }
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
    const directories = uploadReadDirs();
    const seen = new Map<string, { name: string; bytes: number; mtimeMs: number }>();
    for (const directory of directories) {
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        if (!isSafeUploadName(name) || seen.has(name)) continue;
        const info = await stat(join(directory, name)).catch(() => null);
        if (info?.isFile()) seen.set(name, { name, bytes: info.size, mtimeMs: info.mtimeMs });
      }
      for (const reference of await listMediaReferences(directory)) {
        if (isSafeUploadName(reference.name) && !seen.has(reference.name)) {
          seen.set(reference.name, reference);
        }
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

async function handleHydrate(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  dependencies: UploadRouteDependencies,
): Promise<void> {
  if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { name?: string; path?: string };
    const name = hydrateName(body);
    if (!isSafeUploadName(name)) { sendError(res, 400, 'unsafe or missing name'); return; }
    const resolved = await dependencies.resolveUpload(name);
    if (!resolved) {
      sendError(res, 404, r2Config()
        ? `R2 object not found: ${name}`
        : `media not found locally and R2 is off: ${name}`);
      return;
    }
    if (!resolved.cached) logger.info(`[upload/hydrate] ${name} (${resolved.bytes} bytes)`);
    const contentHash = await sha256File(resolved.file);
    sendJson(res, 200, {
      ok: true,
      path: `/media/uploads/${name}`,
      bytes: resolved.bytes,
      contentHash,
      cached: resolved.cached,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, error instanceof UploadTooLargeError ? 413 : 500, message);
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
  if (directR2UploadAllowed()) {
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


function requireEditorMutation(req: IncomingMessage, res: ServerResponse): boolean {
  if (editorCredentialAuthorized(req, true)) return true;
  req.resume();
  sendError(res, 401, 'editor credential required');
  return false;
}

export function registerUploadRoutes(
  server: ViteDevServer,
  dependencies: UploadRouteDependencies = defaultUploadRouteDependencies,
): void {
  const logger = server.config.logger;
  void dependencies.syncLegacy((message) => logger.info(message));
  server.middlewares.use('/media/uploads', (req, res, next) => (
    handleMediaRead(req, res, next, logger, dependencies)
  ));
  server.middlewares.use('/upload/list', handleUploadList);
  server.middlewares.use('/upload/hydrate', (req, res) => {
    if (requireEditorMutation(req, res)) void handleHydrate(req, res, logger, dependencies);
  });
  server.middlewares.use('/upload/presign', (req, res) => {
    if (req.method !== 'POST' || requireEditorMutation(req, res)) void handlePresign(req, res);
  });
  server.middlewares.use('/upload', (req, res) => { void handleUpload(req, res, logger); });
  server.middlewares.use('/api/import-url', (req, res) => {
    if (requireEditorMutation(req, res)) void handleImportUrl(req, res, logger);
  });
}
