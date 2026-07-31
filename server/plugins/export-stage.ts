import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readdir, rename, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import { uploadDir } from '../media-dir.ts';

const STAGE_PREFIX = 'openchatcut-export-stage-';
const STAGE_EXTENSIONS = new Set(['.mp4', '.webm']);
const MAX_STAGE_BYTES = 64 * 1024 ** 3;
export const EXPORT_STAGE_RETENTION_MS = 30 * 60_000;
const STAGE_FILENAME = /^openchatcut-export-stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm)$/i;
const STAGE_PARTIAL_FILENAME = /^openchatcut-export-stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm)\.part$/i;

interface CleanupStageOptions {
  now?: number;
  retentionMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export async function cleanupStaleExportStages(
  directory: string,
  options: CleanupStageOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const retentionMs = Math.max(0, options.retentionMs ?? EXPORT_STAGE_RETENTION_MS);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  });
  let removed = 0;
  for (const entry of entries) {
    const matched = STAGE_FILENAME.test(entry.name) || STAGE_PARTIAL_FILENAME.test(entry.name);
    if (!entry.isFile() || !matched) continue;
    const path = join(directory, entry.name);
    try {
      if (now - (await stat(path)).mtimeMs < retentionMs) continue;
      await unlink(path);
      removed += 1;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return removed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function stageExtension(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://openchatcut.local');
  const extension = extname(url.searchParams.get('name') ?? '').toLowerCase();
  return STAGE_EXTENSIONS.has(extension) ? extension : null;
}

function byteLimiter(onBytes: (value: number) => void): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_STAGE_BYTES) callback(new Error('staged export exceeds 64 GiB limit'));
      else { onBytes(bytes); callback(null, chunk); }
    },
  });
}

async function stageRequest(req: IncomingMessage, extension: string) {
  const filename = `${STAGE_PREFIX}${randomUUID()}${extension}`;
  const finalPath = join(uploadDir(), filename);
  const partialPath = `${finalPath}.part`;
  let sizeBytes = 0;
  try {
    await pipeline(req, byteLimiter((value) => { sizeBytes = value; }), createWriteStream(partialPath, { flags: 'wx' }));
    if (sizeBytes < 1) throw new Error('staged export body is empty');
    await rename(partialPath, finalPath);
    return { filename, sizeBytes: (await stat(finalPath)).size };
  } catch (error) {
    await Promise.all([unlink(partialPath).catch(() => {}), unlink(finalPath).catch(() => {})]);
    throw error;
  }
}

function stageNameFromPath(req: IncomingMessage): string | null {
  const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+|\/+$/g, ''));
  return STAGE_FILENAME.test(name) ? name : null;
}

async function handleStage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'POST') {
    const extension = stageExtension(req);
    if (!extension) { sendJson(res, 400, { error: 'name must end in .mp4 or .webm' }); return; }
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_STAGE_BYTES) {
      sendJson(res, 413, { error: 'staged export exceeds 64 GiB limit' }); return;
    }
    const staged = await stageRequest(req, extension);
    sendJson(res, 200, { path: `/media/uploads/${staged.filename}`, sizeBytes: staged.sizeBytes });
    return;
  }
  if (req.method === 'DELETE') {
    const name = stageNameFromPath(req);
    if (!name) { sendJson(res, 400, { error: 'invalid staged export name' }); return; }
    await unlink(join(uploadDir(), name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    res.statusCode = 204;
    res.end();
    return;
  }
  sendJson(res, 405, { error: 'method not allowed' });
}

export function exportStagePlugin(): Plugin {
  return {
    name: 'openchatcut-export-stage',
    configureServer(server) {
      const cleanup = () => cleanupStaleExportStages(uploadDir()).catch((error) => {
        server.config.logger.warn(`[export-stage] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      void cleanup();
      const cleanupTimer = setInterval(() => { void cleanup(); }, EXPORT_STAGE_RETENTION_MS);
      cleanupTimer.unref();
      server.httpServer?.once('close', () => clearInterval(cleanupTimer));
      server.middlewares.use('/export/stage', (req, res) => {
        void handleStage(req, res).catch((error) => {
          server.config.logger.error(`[export-stage] ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          else res.end();
        });
      });
    },
  };
}
