import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  constants as fsConstants, createReadStream, existsSync, type Stats,
} from 'node:fs';
import {
  copyFile, link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile, type FileHandle,
} from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  deleteUploadObject, effectiveUploadMaxBytes,
  presignGetUpload, presignPutUpload, putUploadFile, r2Config, r2PresignEnabled,
  UploadTooLargeError,
} from '../r2.ts';
import {
  enqueueUploadMutation, isSafeUploadName, resolveOrHydrateUploadFile,
  serveDiskFile, syncLegacyUploads, uploadDir, uploadReadDirs,
} from '../media-dir.ts';
import { isIsolatedDevProfile } from '../runtime-profile.ts';
import { safePublicFetch, UnsafePublicUrlError } from '../safe-public-fetch.ts';
import { deleteMediaPreviewDerivatives } from './media-preview.ts';
import { streamUploadToFile } from './upload-stream.ts';
import { sha256File } from '../../shared/node-content-hash.ts';
import { externalUploadMediaType } from '../../src/media/uploadMediaType.ts';
import {
  authorizeImportUpload,
  mintUploadReceipt,
  type ImportTokenScope,
} from '../external-agent/import-token.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';

const MAX_JSON_BYTES = 64 * 1024;
const IMPORT_TIMEOUT_MS = 30 * 60_000;
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
type CloudState = 'ok' | 'off' | 'failed' | 'exists';

export function maxUploadBytes(): number {
  return effectiveUploadMaxBytes();
}

/** Direct R2 PUT cannot enforce the finite application byte cap, so use the bounded proxy. */
export function directR2UploadAllowed(_presignEnabled = r2PresignEnabled()): boolean {
  return false;
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
  return uploadReadDirs()
    .map((directory) => join(directory, name))
    .find((path) => existsSync(path));
}

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

async function mirrorUpload(
  name: string,
  path: string,
  contentType: string | undefined,
  logger: Logger,
  label: string,
  options?: { ifAbsent: true; rollbackToken: string },
): Promise<CloudState> {
  if (!r2Config()) return 'off';
  try {
    if (options) {
      const result = await putUploadFile(name, path, contentType, options);
      return result === 'exists' ? 'exists' : result === 'off' ? 'off' : 'ok';
    }
    await putUploadFile(name, path, contentType);
    return 'ok';
  } catch (error) {
    logger.error(`[${label}] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    if (options) throw error;
    return 'failed';
  }
}

async function handleDeleteUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const name = url.searchParams.get('name') ?? '';
    if (!isSafeUploadName(name)) { sendError(res, 400, 'unsafe or missing name'); return; }
    const rollbackToken = url.searchParams.get('rollbackToken') ?? undefined;
    if (url.searchParams.has('rollbackToken') && !/^[A-Za-z0-9-]{1,128}$/.test(rollbackToken ?? '')) {
      sendError(res, 400, 'invalid rollback token');
      return;
    }
    const result = await enqueueUploadMutation(name, async () => {
      let removed = 0;
      let derivativesRemoved = 0;
      let r2Removed = false;
      const failures: unknown[] = [];
      for (const directory of uploadReadDirs()) {
        try {
          if (rollbackToken) {
            if (await deleteLocalUploadIfOwned(directory, name, rollbackToken)) removed += 1;
          } else {
            try {
              await unlink(join(directory, name));
              removed += 1;
            } catch (error) {
              if (fileErrorCode(error) !== 'ENOENT') throw error;
            }
            await clearUploadOwner(directory, name);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        r2Removed = await deleteUploadObject(name, rollbackToken);
      } catch (error) {
        failures.push(error);
      }
      if (!rollbackToken || removed > 0 || r2Removed) {
        try {
          derivativesRemoved = await deleteMediaPreviewDerivatives(name);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        const detail = failures.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
        throw new AggregateError(failures, `upload delete incomplete: ${detail}`);
      }
      return {
        ok: true,
        removed,
        r2Removed,
        derivativesRemoved,
        ownershipMatched: !rollbackToken || removed > 0 || r2Removed,
      };
    });
    sendJson(res, 200, result);
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

function fileErrorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? '';
}

interface UploadFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface UploadImportOwner extends UploadFileIdentity {
  rollbackToken: string;
}

function uploadFileIdentity(info: Stats): UploadFileIdentity {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}

function sameUploadFile(
  left: UploadFileIdentity,
  right: UploadFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function uploadOwnerPath(directory: string, name: string): string {
  return join(directory, `.${name}.import-owner.json`);
}

async function restoreCapturedPath(capturedPath: string, originalPath: string): Promise<void> {
  try {
    await link(capturedPath, originalPath);
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === 'EEXIST') {
      await unlink(capturedPath);
      return;
    }
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) throw error;
    try {
      await copyFile(capturedPath, originalPath, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      if (fileErrorCode(copyError) !== 'EEXIST') throw copyError;
    }
  }
  await unlink(capturedPath);
}

async function removeCapturedPathIf(
  path: string,
  predicate: (capturedPath: string) => Promise<boolean>,
): Promise<boolean> {
  const capturedPath = `${path}.${randomUUID()}.rollback`;
  try {
    await rename(path, capturedPath);
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
  let remove: boolean;
  try {
    remove = await predicate(capturedPath);
  } catch (error) {
    await restoreCapturedPath(capturedPath, path);
    throw error;
  }
  if (remove) {
    await unlink(capturedPath);
    return true;
  }
  await restoreCapturedPath(capturedPath, path);
  return false;
}

async function writeUploadOwner(
  directory: string,
  name: string,
  finalPath: string,
  rollbackToken: string,
  expected: UploadFileIdentity,
): Promise<boolean> {
  const current = uploadFileIdentity(await stat(finalPath));
  if (!sameUploadFile(current, expected)) return false;
  const markerPath = uploadOwnerPath(directory, name);
  const partPath = `${markerPath}.${randomUUID()}.part`;
  const owner: UploadImportOwner = { rollbackToken, ...expected };
  try {
    await writeFile(partPath, JSON.stringify(owner), { flag: 'wx' });
    await rename(partPath, markerPath);
    return true;
  } catch (error) {
    await unlink(partPath).catch(() => {});
    throw error;
  }
}

async function clearUploadOwner(directory: string, name: string): Promise<void> {
  try {
    await unlink(uploadOwnerPath(directory, name));
  } catch (error) {
    if (fileErrorCode(error) !== 'ENOENT') throw error;
  }
}

async function deleteLocalUploadIfOwned(
  directory: string,
  name: string,
  rollbackToken: string,
): Promise<boolean> {
  const markerPath = uploadOwnerPath(directory, name);
  const capturedMarker = `${markerPath}.${randomUUID()}.rollback`;
  try {
    await rename(markerPath, capturedMarker);
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
  let owner: UploadImportOwner;
  try {
    owner = JSON.parse(await readFile(capturedMarker, 'utf8')) as UploadImportOwner;
  } catch (error) {
    await restoreCapturedPath(capturedMarker, markerPath);
    throw error;
  }
  if (owner.rollbackToken !== rollbackToken) {
    await restoreCapturedPath(capturedMarker, markerPath);
    return false;
  }
  try {
    const removed = await removeCapturedPathIf(join(directory, name), async (capturedPath) => (
      sameUploadFile(uploadFileIdentity(await stat(capturedPath)), owner)
    ));
    await unlink(capturedMarker);
    return removed;
  } catch (error) {
    await restoreCapturedPath(capturedMarker, markerPath);
    throw error;
  }
}

async function deleteLocalUploadIfIdentity(
  finalPath: string,
  expected: UploadFileIdentity,
): Promise<boolean> {
  return removeCapturedPathIf(finalPath, async (capturedPath) => (
    sameUploadFile(uploadFileIdentity(await stat(capturedPath)), expected)
  ));
}

async function publishPartIfAbsent(
  partPath: string,
  finalPath: string,
): Promise<UploadFileIdentity | null> {
  const partIdentity = uploadFileIdentity(await stat(partPath));
  try {
    await link(partPath, finalPath);
    return partIdentity;
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === 'EEXIST') return null;
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) throw error;
  }
  let target: FileHandle;
  try {
    target = await open(finalPath, 'wx');
  } catch (error) {
    if (fileErrorCode(error) === 'EEXIST') return null;
    throw error;
  }
  const initialIdentity = uploadFileIdentity(await target.stat());
  try {
    await pipeline(
      createReadStream(partPath),
      target.createWriteStream({ autoClose: false }),
    );
    return uploadFileIdentity(await target.stat());
  } catch (error) {
    const cleanupErrors: unknown[] = [error];
    try {
      await removeCapturedPathIf(finalPath, async (capturedPath) => {
        const current = uploadFileIdentity(await stat(capturedPath));
        return current.dev === initialIdentity.dev && current.ino === initialIdentity.ino;
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'exclusive upload copy failed and cleanup was incomplete');
    }
    throw error;
  } finally {
    await target.close().catch(() => {});
  }
}

async function handleUploadWrite(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  handoff?: ImportTokenScope,
): Promise<void> {
  const maxBytes = Math.min(maxUploadBytes(), handoff?.expectedBytes ?? Number.MAX_SAFE_INTEGER);
  let partPath: string | undefined;
  let finalPath: string | undefined;
  let createdLocalIdentity: UploadFileIdentity | undefined;
  let removeCreatedLocal = false;
  let removeCreatedR2 = false;
  let createdServerName: string | undefined;
  let createdRollbackToken: string | undefined;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const original = url.searchParams.get('name') ?? 'file';
    const assetId = (url.searchParams.get('assetId') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const ifAbsent = url.searchParams.get('ifAbsent') === '1';
    const requestedRollbackToken = url.searchParams.get('rollbackToken') ?? '';
    if (ifAbsent && requestedRollbackToken && !/^[A-Za-z0-9-]{1,128}$/.test(requestedRollbackToken)) {
      req.resume();
      sendError(res, 400, 'invalid rollback token');
      return;
    }
    const extension = handoff
      ? externalUploadMediaType(handoff.assetType, handoff.contentType)?.extension
      : extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    if (!extension) throw new Error('unsupported upload handoff media type');
    if (rejectDeclaredSize(req, res, maxBytes)) return;
    const declaredBytes = contentLengthOf(req);
    if (handoff && declaredBytes !== null && declaredBytes !== handoff.expectedBytes) {
      req.resume();
      sendError(res, 400, 'upload byte size does not match handoff');
      return;
    }
    const directory = uploadDir();
    await mkdir(directory, { recursive: true });
    const name = assetId ? `${assetId}${extension}` : `${randomUUID()}${extension}`;
    const path = `/media/uploads/${name}`;
    if (ifAbsent && diskUpload(name)) {
      req.resume();
      const existingContentHash = await sha256File(join(directory, name));
      sendJson(res, 200, { path, contentHash: existingContentHash, created: false, existing: true });
      return;
    }
    partPath = join(directory, `.${name}.${randomUUID()}.part`);
    finalPath = join(directory, name);
    const { bytes, contentHash } = await streamUploadToFile(req, partPath, maxBytes);
    if (handoff && bytes !== handoff.expectedBytes) {
      await unlink(partPath).catch(() => {});
      partPath = undefined;
      sendError(res, 400, 'uploaded bytes do not match handoff');
      return;
    }
    if (bytes === 0) {
      await unlink(partPath).catch(() => {});
      partPath = undefined;
      sendError(res, 400, 'empty body');
      return;
    }
    await enqueueUploadMutation(name, async () => {
      if (ifAbsent) {
        const rollbackToken = requestedRollbackToken || randomUUID();
        try {
          if (diskUpload(name)) {
            const existingContentHash = await sha256File(finalPath!);
            await unlink(partPath!);
            partPath = undefined;
            sendJson(res, 200, {
              path, contentHash: existingContentHash, created: false, existing: true,
            });
            return;
          }
          createdServerName = name;
          createdRollbackToken = rollbackToken;
          const cloud = await mirrorUpload(
            name,
            partPath!,
            req.headers['content-type'] || undefined,
            logger,
            'upload→R2',
            { ifAbsent: true, rollbackToken },
          );
          if (cloud === 'exists') {
            await unlink(partPath!);
            partPath = undefined;
            sendJson(res, 200, { path, created: false, existing: true, cloud });
            return;
          }
          removeCreatedR2 = cloud === 'ok';
          const createdIdentity = await publishPartIfAbsent(partPath!, finalPath!);
          if (!createdIdentity) {
            await unlink(partPath!);
            partPath = undefined;
            if (removeCreatedR2) {
              await deleteUploadObject(name, rollbackToken);
              removeCreatedR2 = false;
            }
            sendJson(res, 200, {
              path,
              contentHash: await sha256File(finalPath!),
              created: false,
              existing: true,
              cloud,
            });
            return;
          }
          createdLocalIdentity = createdIdentity;
          removeCreatedLocal = true;
          const markerWritten = await writeUploadOwner(
            directory,
            name,
            finalPath!,
            rollbackToken,
            createdIdentity,
          );
          if (!markerWritten) {
            removeCreatedLocal = false;
            createdLocalIdentity = undefined;
            if (removeCreatedR2) {
              await deleteUploadObject(name, rollbackToken);
              removeCreatedR2 = false;
            }
            await unlink(partPath!);
            partPath = undefined;
            sendJson(res, 200, {
              path, contentHash, created: false, existing: true, cloud,
            });
            return;
          }
          await unlink(partPath!);
          partPath = undefined;
          sendJson(res, 200, {
            path, bytes, contentHash, fileKey: `uploads/${name}`,
            assetId: assetId || undefined, cloud, created: true, rollbackToken,
          });
          removeCreatedLocal = false;
          createdLocalIdentity = undefined;
          removeCreatedR2 = false;
          return;
        } catch (error) {
          const failures: unknown[] = [error];
          if (removeCreatedLocal) {
            try {
              const removed = await deleteLocalUploadIfOwned(directory, name, rollbackToken);
              if (!removed && createdLocalIdentity) {
                await deleteLocalUploadIfIdentity(finalPath!, createdLocalIdentity);
              }
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
            removeCreatedLocal = false;
            createdLocalIdentity = undefined;
          }
          if (removeCreatedR2) {
            try {
              await deleteUploadObject(name, rollbackToken);
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
            removeCreatedR2 = false;
          }
          if (partPath) {
            try {
              await unlink(partPath);
            } catch (cleanupError) {
              if (fileErrorCode(cleanupError) !== 'ENOENT') failures.push(cleanupError);
            }
            partPath = undefined;
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, 'create-only upload failed and rollback was incomplete');
          }
          throw error;
        }
      }
      await rename(partPath!, finalPath!);
      partPath = undefined;
      await clearUploadOwner(directory, name);
      const cloud = await mirrorUpload(name, finalPath!, req.headers['content-type'] || undefined, logger, 'upload→R2');
      const fileKey = `uploads/${name}`;
      const receipt = handoff
        ? mintUploadReceipt(handoff, { path, fileKey, bytes, contentHash })
        : undefined;
      sendJson(res, 200, {
        path, bytes, contentHash, fileKey,
        sessionId: handoff?.sessionId,
        state: handoff ? 'uploaded' : undefined,
        assetId: assetId || undefined,
        assetType: handoff?.assetType,
        filename: handoff?.filename,
        cloud, created: true, receipt,
      });
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (partPath) {
      try { await unlink(partPath); } catch (cleanupError) {
        if (fileErrorCode(cleanupError) !== 'ENOENT') failures.push(cleanupError);
      }
    }
    if (removeCreatedLocal && finalPath && createdLocalIdentity) {
      try {
        const removed = createdServerName && createdRollbackToken
          ? await deleteLocalUploadIfOwned(uploadDir(), createdServerName, createdRollbackToken)
          : false;
        if (!removed) await deleteLocalUploadIfIdentity(finalPath, createdLocalIdentity);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      removeCreatedLocal = false;
      createdLocalIdentity = undefined;
    }
    if (removeCreatedR2 && createdServerName) {
      try {
        await deleteUploadObject(createdServerName, createdRollbackToken);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    const failure = failures.length > 1
      ? new AggregateError(failures, 'upload failed and temporary cleanup was incomplete')
      : error;
    const message = failure instanceof Error ? failure.message : String(failure);
    logger.error(`[upload] ${message}`);
    if (!res.headersSent) sendError(res, error instanceof UploadTooLargeError ? 413 : 500, message);
    else res.end();
  }
}

async function handleUpload(req: IncomingMessage, res: ServerResponse, logger: Logger): Promise<void> {
  if (req.method === 'DELETE') {
    if (!editorCredentialAuthorized(req, true)) {
      req.resume();
      sendError(res, 401, 'editor credential required');
      return;
    }
    await handleDeleteUpload(req, res);
    return;
  }
  if (req.method !== 'POST' && req.method !== 'PUT') {
    sendError(res, 405, 'method not allowed — use POST, PUT or DELETE');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let handoff: ImportTokenScope | undefined;
  if (url.searchParams.has('handoff')) {
    const authorization = authorizeImportUpload(
      url,
      req.method,
      typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
    );
    if (authorization.status !== 'accepted') {
      req.resume();
      sendError(res, 401, 'invalid or expired upload handoff');
      return;
    }
    handoff = authorization.scope;
  } else if (!editorCredentialAuthorized(req, true)) {
    req.resume();
    sendError(res, 401, 'editor credential required');
    return;
  }
  await handleUploadWrite(req, res, logger, handoff);
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
  if (!remote) { sendError(res, 400, 'url must be a public http(s) URI'); return null; }
  const nameHint = typeof body.name === 'string' ? body.name.trim() : undefined;
  let response: Response;
  try {
    response = await safePublicFetch(remote, {
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      headers: { 'User-Agent': 'openchatcut-import/1.0' },
    });
  } catch (error) {
    if (error instanceof UnsafePublicUrlError) {
      sendError(res, 400, error.message);
      return null;
    }
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    sendError(res, 200, `upstream HTTP ${response.status}`);
    return null;
  }
  const contentType = response.headers.get('content-type');
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/html') {
    await response.body?.cancel().catch(() => undefined);
    sendError(res, 400, 'upstream returned HTML instead of media');
    return null;
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    sendError(res, 413, new UploadTooLargeError(maxBytes).message);
    return null;
  }
  if (!response.body) { sendError(res, 400, 'upstream empty body'); return null; }
  return { response, remote, nameHint, contentType };
}
async function saveRemoteImport(imported: RemoteImport, maxBytes: number, logger: Logger, res: ServerResponse) {
  const extension = extFromUrlOrType(imported.remote, imported.contentType, imported.nameHint);
  const directory = uploadDir();
  await mkdir(directory, { recursive: true });
  const name = `${randomUUID()}${extension}`;
  const partPath = join(directory, `.${name}.part`);
  const finalPath = join(directory, name);
  const body = Readable.fromWeb(imported.response.body as WebReadableStream);
  const { bytes, contentHash } = await streamUploadToFile(body, partPath, maxBytes);
  if (bytes === 0) {
    await unlink(partPath).catch(() => {});
    sendError(res, 400, 'upstream empty body'); return null;
  }
  await rename(partPath, finalPath);
  await mirrorUpload(name, finalPath, imported.contentType ?? undefined, logger, 'import-url→R2');
  return { name, bytes, contentHash };
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
      ok: true, path: `/media/uploads/${saved.name}`, bytes: saved.bytes, contentHash: saved.contentHash,
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
