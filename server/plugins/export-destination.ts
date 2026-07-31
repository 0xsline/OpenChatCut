import { randomUUID } from 'node:crypto';
import { open, rename, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import { resolveExportDirectoryGrant } from '../export-destinations.ts';
import { sanitizeFileName } from '../file-name.ts';

const MAX_EXPORT_BYTES = 100 * 1024 * 1024 * 1024;
const GRANT_ID = /^[A-Za-z0-9_-]{32,128}$/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

class ExportDestinationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
  try {
    await pipeline(req as Readable, limiter, file.createWriteStream());
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

export async function handleExportDestinationPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'PUT') throw new ExportDestinationError(405, 'method not allowed — use PUT');
  const { grantId, filename } = parseRoute(req.url ?? '/');
  const grant = resolveExportDirectoryGrant(grantId);
  if (!grant) throw new ExportDestinationError(404, 'export destination not found');
  const directory = resolve(grant.directory);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new ExportDestinationError(410, 'export destination is unavailable');
  const target = resolve(directory, filename);
  if (dirname(target) !== directory) throw new ExportDestinationError(400, 'invalid export filename');
  const temporary = resolve(directory, `.openchatcut-${randomUUID()}.part`);
  await streamRequest(req, temporary);
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
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
          sendJson(res, expected ? error.status : 500, {
            error: expected ? error.message : 'failed to write export file',
          });
        }
      });
    },
  };
}
