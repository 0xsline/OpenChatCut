import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import {
  constants as fsConstants, createReadStream, existsSync, type Stats,
} from 'node:fs';
import {
  copyFile, link, open, readFile, rename, stat, unlink, writeFile, type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import {
  deleteUploadObject, putUploadFile, r2Config, UploadTooLargeError,
} from '../r2.ts';
import { enqueueUploadMutation, isSafeUploadName, uploadReadDirs } from '../media-dir.ts';
import { deleteMediaPreviewDerivatives } from './media-preview.ts';
import { contentLengthOf, sendError, sendJson } from './upload-route-http.ts';

type Logger = ViteDevServer['config']['logger'];
type CloudState = 'ok' | 'off' | 'failed' | 'exists';

function diskUpload(name: string): string | undefined {
  return uploadReadDirs()
    .map((directory) => join(directory, name))
    .find((path) => existsSync(path));
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

export {
  clearUploadOwner,
  deleteLocalUploadIfIdentity,
  deleteLocalUploadIfOwned,
  diskUpload,
  fileErrorCode,
  handleDeleteUpload,
  mirrorUpload,
  rejectDeclaredSize,
  publishPartIfAbsent,
  writeUploadOwner,
};
export type { UploadFileIdentity };
