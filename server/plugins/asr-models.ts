// On-device ASR model management endpoints — users download/delete models from
// Settings → 转写 → 本地模型. Downloads reuse hf-proxy's multi-source
// accelerated fetch into the shared disk cache; progress is per-file
// granularity (bytes of completed files / total bytes).
//
//   GET  /api/asr-models              → catalog + per-model downloaded state
//   POST /api/asr-models/download     → { id } start background download
//   GET  /api/asr-models/download/:id → task status { status, progress, … }
//   POST /api/asr-models/delete       → { id } remove cached files
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ASR_MODELS,
  asrModelEntry,
  type AsrDownloadTask,
  type AsrModelEntry,
  type AsrModelFile,
} from '../../shared/asr-models.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { downloadModelFile, modelCacheDir } from './hf-proxy.ts';

const MAX_JSON = 8 * 1024;

const tasks = new Map<string, AsrDownloadTask>();
const inspections = new Map<string, {
  fingerprint: string;
  result: { downloaded: boolean; bytes: number };
}>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function requireAsrMutation(req: IncomingMessage, res: ServerResponse): boolean {
  if (!editorCredentialAuthorized(req, true)) {
    req.resume();
    sendJson(res, 401, { error: 'editor credential required' });
    return false;
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (contentType === 'application/json') return true;
  req.resume();
  sendJson(res, 415, { error: 'content-type must be application/json' });
  return false;
}

function readJson(req: IncomingMessage, max = MAX_JSON): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
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
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
    } catch (error) {
      reject(error);
    }
  });
  req.on('error', reject);
  return promise;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Native ASR request canceled', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function modelFileVerified(
  path: string,
  file: AsrModelFile,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  try {
    if ((await stat(path)).size !== file.sizeBytes) return false;
    throwIfAborted(signal);
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    const onAbort = (): void => {
      if (signal) stream.destroy(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      for await (const chunk of stream) {
        throwIfAborted(signal);
        hash.update(chunk);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    throwIfAborted(signal);
    return hash.digest('hex') === file.sha256;
  } catch {
    throwIfAborted(signal);
    return false;
  }
}
export async function inspectAsrModel(
  entry: AsrModelEntry,
  cacheDir = modelCacheDir(),
  signal?: AbortSignal,
): Promise<{ downloaded: boolean; bytes: number }> {
  throwIfAborted(signal);
  const stats: string[] = [];
  for (const file of entry.files) {
    throwIfAborted(signal);
    try {
      const info = await stat(join(cacheDir, entry.modelId, file.path));
      throwIfAborted(signal);
      if (!info.isFile() || info.size !== file.sizeBytes) return { downloaded: false, bytes: 0 };
      stats.push(`${file.path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
    } catch {
      throwIfAborted(signal);
      return { downloaded: false, bytes: 0 };
    }
  }
  const key = `${cacheDir}\0${entry.modelId}`;
  throwIfAborted(signal);
  const fingerprint = stats.join('|');
  const cached = inspections.get(key);
  if (cached?.fingerprint === fingerprint) return cached.result;
  const downloaded = (await Promise.all(entry.files.map((file) =>
    modelFileVerified(join(cacheDir, entry.modelId, file.path), file, signal)))).every(Boolean);
  const result = { downloaded, bytes: downloaded ? entry.files.reduce(
    (total, file) => total + file.sizeBytes, 0,
  ) : 0 };
  inspections.set(key, { fingerprint, result });
  return result;
}

function catalogState(): Promise<Array<{
  id: string; modelId: string; label: string; sizeLabel: string; language: string;
  downloaded: boolean; bytes: number; task?: AsrDownloadTask;
}>> {
  return Promise.all(ASR_MODELS.map(async (entry) => {
    const state = await inspectAsrModel(entry);
    return {
      id: entry.id,
      modelId: entry.modelId,
      label: entry.label,
      sizeLabel: entry.sizeLabel,
      language: entry.language,
      downloaded: state.downloaded,
      bytes: state.bytes,
      task: tasks.get(entry.id),
    };
  }));
}

async function startDownload(id: string): Promise<AsrDownloadTask> {
  const entry = asrModelEntry(id);
  if (!entry) throw new Error(`unknown model ${id}`);
  const existing = tasks.get(id);
  if (existing && existing.status === 'downloading') return existing;
  const task: AsrDownloadTask = {
    id,
    status: 'downloading',
    bytesDone: 0,
    bytesTotal: entry.files.reduce((total, file) => total + file.sizeBytes, 0),
    filesDone: 0,
    filesTotal: entry.files.length,
  };
  inspections.delete(`${modelCacheDir()}\0${entry.modelId}`);
  tasks.set(id, task);
  void (async () => {
    try {
      for (const file of entry.files) {
        const path = join(modelCacheDir(), entry.modelId, file.path);
        if (await modelFileVerified(path, file)) {
          task.filesDone += 1;
          task.bytesDone += file.sizeBytes;
          continue;
        }
        await rm(path, { force: true });
        await downloadModelFile(
          { modelId: entry.modelId, revision: entry.revision, filePath: file.path },
          undefined,
          { expectedBytes: file.sizeBytes, expectedSha256: file.sha256 },
        );
        task.filesDone += 1;
        task.bytesDone += file.sizeBytes;
      }
      task.status = 'done';
    } catch (error) {
      task.status = 'error';
      task.error = error instanceof Error ? error.message : String(error);
    }
  })();
  return task;
}

async function deleteModel(id: string): Promise<boolean> {
  const entry = asrModelEntry(id);
  if (!entry) throw new Error(`unknown model ${id}`);
  const task = tasks.get(id);
  if (task?.status === 'downloading') throw new Error(`model ${id} is downloading`);
  await rm(join(modelCacheDir(), entry.modelId), { recursive: true, force: true });
  tasks.delete(id);
  inspections.delete(`${modelCacheDir()}\0${entry.modelId}`);
  return true;
}

export async function handleAsrModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (pathname === '/api/asr-models' && req.method === 'GET') {
    sendJson(res, 200, { models: await catalogState() });
    return;
  }
  if (pathname === '/api/asr-models/download' && req.method === 'POST') {
    if (!requireAsrMutation(req, res)) return;
    try {
      const body = await readJson(req);
      const id = String(body.id ?? '');
      const task = await startDownload(id);
      sendJson(res, 200, { ok: true, task });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const dlMatch = /^\/api\/asr-models\/download\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (dlMatch && req.method === 'GET') {
    const task = tasks.get(dlMatch[1]);
    sendJson(res, 200, task ?? { status: 'idle' });
    return;
  }
  if (pathname === '/api/asr-models/delete' && req.method === 'POST') {
    if (!requireAsrMutation(req, res)) return;
    try {
      const body = await readJson(req);
      await deleteModel(String(body.id ?? ''));
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

export function asrModelsPlugin(): Plugin {
  return {
    name: 'openchatcut-asr-models',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        if (!pathname.startsWith('/api/asr-models')) {
          next();
          return;
        }
        void handleAsrModelsRequest(req, res, pathname).catch((error) => {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
    },
  };
}

/** Test seam: reset in-memory tasks and integrity inspections. */
export function __resetAsrTasks(): void {
  tasks.clear();
  inspections.clear();
}
