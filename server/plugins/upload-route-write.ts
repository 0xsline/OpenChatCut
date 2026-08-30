import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  deleteUploadObject, UploadTooLargeError,
} from '../r2.ts';
import { enqueueUploadMutation, uploadDir } from '../media-dir.ts';
import { safePublicFetch, UnsafePublicUrlError } from '../safe-public-fetch.ts';
import { streamUploadToFile } from './upload-stream.ts';
import { sha256File } from '../../shared/node-content-hash.ts';
import { externalUploadMediaType } from '../../src/media/uploadMediaType.ts';
import {
  authorizeImportUpload,
  mintUploadReceipt,
  type ImportTokenScope,
} from '../external-agent/import-token.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { scrubInternalPaths } from '../error-scrub.ts';
import {
  contentLengthOf, extFromUrlOrType, maxUploadBytes, readBody,
  sendError, sendJson,
} from './upload-route-http.ts';
import {
  clearUploadOwner, deleteLocalUploadIfIdentity, deleteLocalUploadIfOwned,
  diskUpload, fileErrorCode, handleDeleteUpload, mirrorUpload,
  publishPartIfAbsent, rejectDeclaredSize, type UploadFileIdentity, writeUploadOwner,
} from './upload-route-storage.ts';

const IMPORT_TIMEOUT_MS = 30 * 60_000;
type Logger = ViteDevServer['config']['logger'];

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
    const name = handoff
      ? `${handoff.assetId}.${handoff.sessionId}${extension}`
      : assetId ? `${assetId}${extension}` : `${randomUUID()}${extension}`;
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
    // Full detail (paths included) stays in the server log; the client gets the
    // same sentence with host filesystem paths scrubbed.
    if (!res.headersSent) {
      sendError(res, error instanceof UploadTooLargeError ? 413 : 500, scrubInternalPaths(message));
    }
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


export { handleImportUrl, handleUpload };
