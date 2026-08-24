import { randomUUID } from 'node:crypto';
import { copyFile, open, rename, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import { resolveExportDirectoryGrant } from '../export-destinations.ts';
import { sanitizeFileName } from '../file-name.ts';
import { resolveUploadFile } from '../media-dir.ts';
import { createExportFailure, type ExportCleanupStatus } from '../../src/export/exportFailure.ts';

const MAX_EXPORT_BYTES = 100 * 1024 * 1024 * 1024;
const GRANT_ID = /^[A-Za-z0-9_-]{32,128}$/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SOURCE_HEADER = 'x-openchatcut-export-source';
const leasedTargets = new Set<string>();

class ExportDestinationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly cleanupStatus: ExportCleanupStatus;
  readonly targetPath: string | null;

  constructor(status: number, message: string, options: {
    code?: string;
    retryable?: boolean;
    cleanupStatus?: ExportCleanupStatus;
    targetPath?: string | null;
  } = {}) {
    super(message);
    this.status = status;
    this.code = options.code ?? 'export_destination_failed';
    this.retryable = options.retryable ?? (status === 409 || status >= 500);
    this.cleanupStatus = options.cleanupStatus ?? 'not-required';
    this.targetPath = options.targetPath ?? null;
  }
}

function acquireTargetLease(target: string): () => void {
  if (leasedTargets.has(target)) {
    throw new ExportDestinationError(409, 'export target is already being written', {
      code: 'export_target_leased',
      retryable: true,
      targetPath: target,
    });
  }
  leasedTargets.add(target);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    leasedTargets.delete(target);
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ExportDestinationError(400, 'invalid export destination path encoding');
  }
}

function validFilename(name: string): boolean {
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name, 'utf8') > 240) return false;
  if (name !== sanitizeFileName(name, '') || /[\x7f]/.test(name)) return false;
  if (/[. ]$/.test(name) || RESERVED_WINDOWS_NAME.test(name)) return false;
  return true;
}

function parseRoute(url: string): { grantId: string; filename: string } {
  const path = url.split('?', 1)[0] ?? '';
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== '') {
    throw new ExportDestinationError(400, 'expected an export grant and filename');
  }
  const grantId = decodeSegment(parts[1] ?? '');
  const filename = decodeSegment(parts[2] ?? '');
  if (!GRANT_ID.test(grantId)) throw new ExportDestinationError(404, 'export destination not found');
  if (!validFilename(filename)) throw new ExportDestinationError(400, 'invalid export filename');
  return { grantId, filename };
}

function requestLength(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ExportDestinationError(400, 'invalid content length');
  }
  if (parsed > MAX_EXPORT_BYTES) throw new ExportDestinationError(413, 'export file is too large');
  return parsed;
}

async function streamRequest(req: IncomingMessage, path: string): Promise<void> {
  requestLength(req);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      const error = bytes > MAX_EXPORT_BYTES
        ? new ExportDestinationError(413, 'export file is too large')
        : null;
      callback(error, chunk);
    },
  });
  const file = await open(path, 'wx', 0o600);
  await pipeline(req as Readable, limiter, file.createWriteStream());
}

function exportSource(
  req: IncomingMessage,
  target: string,
  resolveSource: (name: string) => string | null,
): string | null {
  const raw = req.headers[SOURCE_HEADER];
  if (raw === undefined) return null;
  const prefix = '/media/uploads/';
  if (Array.isArray(raw) || !raw.startsWith(prefix)) {
    throw new ExportDestinationError(400, 'invalid export source', { targetPath: target });
  }
  const source = resolveSource(decodeSegment(raw.slice(prefix.length)));
  if (source) return source;
  throw new ExportDestinationError(404, 'export source is unavailable', {
    code: 'export_source_read_failed', retryable: true, targetPath: target,
  });
}

export async function handleExportDestinationPut(
  req: IncomingMessage,
  res: ServerResponse,
  resolveSource: (name: string) => string | null = resolveUploadFile,
): Promise<void> {
  if (req.method !== 'PUT') throw new ExportDestinationError(405, 'method not allowed — use PUT');
  const { grantId, filename } = parseRoute(req.url ?? '/');
  const grant = resolveExportDirectoryGrant(grantId);
  if (!grant) throw new ExportDestinationError(404, 'export destination not found');
  const directory = resolve(grant.directory);
  const target = resolve(directory, filename);
  if (dirname(target) !== directory) throw new ExportDestinationError(400, 'invalid export filename');
  const source = exportSource(req, target, resolveSource);
  const releaseLease = acquireTargetLease(target);
  try {
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) {
      throw new ExportDestinationError(410, 'export destination is unavailable', {
        code: 'export_destination_unavailable',
        retryable: true,
        targetPath: target,
      });
    }
    const temporary = resolve(directory, `.openchatcut-${randomUUID()}.part`);
    try {
      if (source) {
        const sourceInfo = await stat(source);
        if (!sourceInfo.isFile()) throw new ExportDestinationError(404, 'export source is unavailable');
        if (sourceInfo.size > MAX_EXPORT_BYTES) throw new ExportDestinationError(413, 'export file is too large');
        await copyFile(source, temporary);
      } else {
        await streamRequest(req, temporary);
      }
      if ((await stat(temporary)).size === 0) {
        throw new ExportDestinationError(422, 'export file is empty', {
          code: 'export_output_empty', retryable: true,
        });
      }
      await rename(temporary, target);
    } catch (error) {
      let cleanupStatus: ExportCleanupStatus = 'succeeded';
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) {
          cleanupStatus = 'failed';
        }
      }
      if (error instanceof ExportDestinationError) {
        throw new ExportDestinationError(error.status, error.message, {
          code: error.code,
          retryable: error.retryable,
          cleanupStatus,
          targetPath: target,
        });
      }
      throw new ExportDestinationError(500, error instanceof Error ? error.message : 'failed to write export file', {
        code: 'export_destination_write_failed',
        retryable: true,
        cleanupStatus,
        targetPath: target,
      });
    }
    res.statusCode = 204;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  } finally {
    releaseLease();
  }
}

export function exportDestinationPlugin(): Plugin {
  return {
    name: 'openchatcut-export-destination',
    configureServer(server) {
      server.middlewares.use('/api/export-destinations', async (req, res) => {
        try {
          await handleExportDestinationPut(req, res);
        } catch (error) {
          if (res.writableEnded) return;
          const expected = error instanceof ExportDestinationError;
          if (!expected) server.config.logger.error(`[export-destination] ${error instanceof Error ? error.message : String(error)}`);
          const message = expected ? error.message : 'failed to write export file';
          const failure = createExportFailure({
            stage: 'destination',
            code: expected ? error.code : 'export_destination_failed',
            retryable: expected ? error.retryable : true,
            cleanupStatus: expected ? error.cleanupStatus : 'not-required',
            targetPath: expected ? error.targetPath : null,
            message,
          });
          sendJson(res, expected ? error.status : 500, { error: message, failure });
        }
      });
    },
  };
}
