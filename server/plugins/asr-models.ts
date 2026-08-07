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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ASR_MODEL_FILES, ASR_MODELS, asrModelEntry, type AsrDownloadTask } from '../../shared/asr-models.ts';
import { downloadModelFile, modelCacheDir } from './hf-proxy.ts';

const MAX_JSON = 8 * 1024;

const tasks = new Map<string, AsrDownloadTask>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
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

/** True when every catalog file exists on disk and is non-empty. */
async function modelDownloaded(modelId: string): Promise<{ downloaded: boolean; bytes: number }> {
  let bytes = 0;
  for (const file of ASR_MODEL_FILES) {
    const path = join(modelCacheDir(), modelId, file);
    if (!existsSync(path)) return { downloaded: false, bytes };
    const size = (await stat(path)).size;
    if (size <= 0) return { downloaded: false, bytes };
    bytes += size;
  }
  return { downloaded: true, bytes };
}

function catalogState(): Promise<Array<{
  id: string; modelId: string; label: string; sizeLabel: string; language: string;
  downloaded: boolean; bytes: number; task?: AsrDownloadTask;
}>> {
  return Promise.all(ASR_MODELS.map(async (entry) => {
    const state = await modelDownloaded(entry.modelId);
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
    id, status: 'downloading', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: ASR_MODEL_FILES.length,
  };
  tasks.set(id, task);
  void (async () => {
    try {
      for (const file of ASR_MODEL_FILES) {
        const path = join(modelCacheDir(), entry.modelId, file);
        if (existsSync(path) && (await stat(path)).size > 0) {
          task.filesDone += 1;
          task.bytesDone += (await stat(path)).size;
          continue;
        }
        await downloadModelFile({ modelId: entry.modelId, revision: 'main', filePath: file });
        task.filesDone += 1;
        task.bytesDone += (await stat(path)).size;
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
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (pathname === '/api/asr-models' && req.method === 'GET') {
    sendJson(res, 200, { models: await catalogState() });
    return;
  }
  if (pathname === '/api/asr-models/download' && req.method === 'POST') {
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
        void handle(req, res, pathname).catch((error) => {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
    },
  };
}

/** Test seam: reset in-memory tasks. */
export function __resetAsrTasks(): void {
  tasks.clear();
}
