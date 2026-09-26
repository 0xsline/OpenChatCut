// On-device ASR model management endpoints — users download/delete models from
// Settings → 转写 → 本地模型. Downloads reuse hf-proxy's multi-source
// accelerated fetch into the shared disk cache; progress is per-file
// granularity (bytes of completed files / total bytes).
//
//   GET  /api/asr-models              → catalog + per-model, per-engine downloaded state
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
import {
  GGML_SOURCE_MODEL_ID, ggmlCachePath, legacyGgmlCachePath, resolveGgmlPath,
} from '../../shared/asr-ggml-cache.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { downloadModelFile, modelCacheDir, type ProxyTarget } from './hf-proxy.ts';

const MAX_JSON = 8 * 1024;

const tasks = new Map<string, AsrDownloadTask>();
/** Last sha256 verdict per file group, reused while the files' stat fingerprint holds. */
const inspections = new Map<string, { fingerprint: string; verified: boolean }>();

/**
 * Per-engine readiness of one tier. Each flag means every file of that group is
 * present with its catalog size and sha256.
 */
export interface AsrModelInspection {
  /** The ONNX export the browser (transformers.js) engine loads. */
  readonly onnxDownloaded: boolean;
  /** The GGML companion desktop whisper.cpp loads; false for a tier without one. */
  readonly ggmlDownloaded: boolean;
  /** Every file the tier lists. The only flag clients had before #168; kept for them. */
  readonly downloaded: boolean;
  /** Bytes of the verified groups. */
  readonly bytes: number;
}

function inspectionKey(cacheDir: string, entry: AsrModelEntry, group: 'onnx' | 'ggml'): string {
  return `${cacheDir}\0${entry.modelId}\0${group}`;
}

function forgetInspections(cacheDir: string, entry: AsrModelEntry): void {
  inspections.delete(inspectionKey(cacheDir, entry, 'onnx'));
  inspections.delete(inspectionKey(cacheDir, entry, 'ggml'));
}

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
  file: Pick<AsrModelFile, 'sizeBytes' | 'sha256'>,
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

/**
 * Whether every file is present with its catalog size and sha256. Hashing is
 * skipped while the files' stat fingerprint matches the last verdict for `key`.
 */
async function filesVerified(
  key: string,
  files: readonly AsrModelDownload[],
  signal?: AbortSignal,
): Promise<boolean> {
  const stats: string[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    try {
      const info = await stat(file.destination);
      throwIfAborted(signal);
      if (!info.isFile() || info.size !== file.sizeBytes) return false;
      stats.push(`${file.destination}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }
  throwIfAborted(signal);
  const fingerprint = stats.join('|');
  const cached = inspections.get(key);
  if (cached?.fingerprint === fingerprint) return cached.verified;
  const verified = (await Promise.all(files.map((file) =>
    modelFileVerified(file.destination, file, signal)))).every(Boolean);
  inspections.set(key, { fingerprint, verified });
  return verified;
}

function totalBytes(files: readonly AsrModelDownload[]): number {
  return files.reduce((total, file) => total + file.sizeBytes, 0);
}

export async function inspectAsrModel(
  entry: AsrModelEntry,
  cacheDir = modelCacheDir(),
  signal?: AbortSignal,
): Promise<AsrModelInspection> {
  throwIfAborted(signal);
  // Adopt a companion an older build stranded before checking it.
  if (entry.ggmlFile) resolveGgmlPath(cacheDir, entry.ggmlFile.fileName);
  const files = asrModelDownloads(entry, cacheDir);
  const onnx = files.filter((file) => file.target.modelId === entry.modelId);
  const ggml = files.filter((file) => file.target.modelId === GGML_SOURCE_MODEL_ID);
  // Each engine is judged on its own files only: a missing companion must not
  // hide a complete ONNX export from the browser engine, nor the reverse (#168).
  const [onnxDownloaded, ggmlDownloaded] = await Promise.all([
    filesVerified(inspectionKey(cacheDir, entry, 'onnx'), onnx, signal),
    ggml.length > 0 ? filesVerified(inspectionKey(cacheDir, entry, 'ggml'), ggml, signal) : false,
  ]);
  return {
    onnxDownloaded,
    ggmlDownloaded,
    downloaded: onnxDownloaded && (ggmlDownloaded || ggml.length === 0),
    bytes: (onnxDownloaded ? totalBytes(onnx) : 0) + (ggmlDownloaded ? totalBytes(ggml) : 0),
  };
}

function catalogState(cacheDir = modelCacheDir()): Promise<Array<AsrModelInspection & {
  id: string; modelId: string; label: string; sizeLabel: string; language: string;
  task?: AsrDownloadTask;
}>> {
  return Promise.all(ASR_MODELS.map(async (entry) => {
    const state = await inspectAsrModel(entry, cacheDir);
    return {
      id: entry.id,
      modelId: entry.modelId,
      label: entry.label,
      sizeLabel: entry.sizeLabel,
      language: entry.language,
      downloaded: state.downloaded,
      onnxDownloaded: state.onnxDownloaded,
      ggmlDownloaded: state.ggmlDownloaded,
      bytes: state.bytes,
      task: tasks.get(entry.id),
    };
  }));
}

/** One catalog file: where the downloader fetches it from and writes it to. */
export interface AsrModelDownload {
  readonly target: ProxyTarget;
  /** Always explicit, and always the path the inspection and the desktop worker read. */
  readonly destination: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Every file of a tier in download order: the browser engine's ONNX export,
 * then the whisper.cpp companion. The companion comes from another repo, so
 * hf-proxy's default destination — derived from the source repo id — is
 * `<cache>/ggerganov/whisper.cpp/`, a directory no reader looks in. Leaving it
 * implicit is how every GGML tier stayed "not downloaded" from v0.2.2 to v0.2.14.
 */
export function asrModelDownloads(entry: AsrModelEntry, cacheDir: string): AsrModelDownload[] {
  const downloads: AsrModelDownload[] = entry.files.map((file) => ({
    target: { modelId: entry.modelId, revision: entry.revision, filePath: file.path },
    destination: join(cacheDir, entry.modelId, ...file.path.split('/')),
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  }));
  const ggml = entry.ggmlFile;
  if (!ggml) return downloads;
  return [...downloads, {
    target: { modelId: GGML_SOURCE_MODEL_ID, revision: ggml.revision, filePath: ggml.fileName },
    destination: ggmlCachePath(cacheDir, ggml.fileName),
    sizeBytes: ggml.sizeBytes,
    sha256: ggml.sha256,
  }];
}

/** Fetch the files of `entry` that are missing or fail verification. */
async function downloadAsrModel(
  entry: AsrModelEntry,
  task: AsrDownloadTask,
  cacheDir: string,
  download: typeof downloadModelFile,
): Promise<void> {
  // Adopt a companion an older build stranded before deciding to re-fetch it.
  if (entry.ggmlFile) resolveGgmlPath(cacheDir, entry.ggmlFile.fileName);
  for (const file of asrModelDownloads(entry, cacheDir)) {
    if (!(await modelFileVerified(file.destination, file))) {
      await rm(file.destination, { force: true });
      await download(file.target, file.destination, {
        expectedBytes: file.sizeBytes, expectedSha256: file.sha256,
      });
    }
    task.filesDone += 1;
    task.bytesDone += file.sizeBytes;
  }
}

function newDownloadTask(entry: AsrModelEntry): AsrDownloadTask {
  const ggml = entry.ggmlFile;
  return {
    id: entry.id,
    status: 'downloading',
    bytesDone: 0,
    bytesTotal: entry.files.reduce((total, file) => total + file.sizeBytes, 0)
      + (ggml ? ggml.sizeBytes : 0),
    filesDone: 0,
    filesTotal: entry.files.length + (ggml ? 1 : 0),
  };
}

async function startDownload(id: string): Promise<AsrDownloadTask> {
  const entry = asrModelEntry(id);
  if (!entry) throw new Error(`unknown model ${id}`);
  const existing = tasks.get(id);
  if (existing && existing.status === 'downloading') return existing;
  const task = newDownloadTask(entry);
  forgetInspections(modelCacheDir(), entry);
  tasks.set(id, task);
  void downloadAsrModel(entry, task, modelCacheDir(), downloadModelFile).then(() => {
    task.status = 'done';
  }, (error: unknown) => {
    task.status = 'error';
    task.error = error instanceof Error ? error.message : String(error);
  });
  return task;
}

async function deleteModel(id: string): Promise<boolean> {
  const entry = asrModelEntry(id);
  if (!entry) throw new Error(`unknown model ${id}`);
  const task = tasks.get(id);
  if (task?.status === 'downloading') throw new Error(`model ${id} is downloading`);
  await rm(join(modelCacheDir(), entry.modelId), { recursive: true, force: true });
  if (entry.ggmlFile) {
    await rm(resolveGgmlPath(modelCacheDir(), entry.ggmlFile.fileName), { force: true });
    await rm(legacyGgmlCachePath(modelCacheDir(), entry.ggmlFile.fileName), { force: true });
  }
  tasks.delete(id);
  forgetInspections(modelCacheDir(), entry);
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

/** Test seam: the GET /api/asr-models rows for `cacheDir`. */
export function __asrCatalogForVerify(cacheDir: string): ReturnType<typeof catalogState> {
  return catalogState(cacheDir);
}

/** Test seam: run the real download routine against `cacheDir` with a stand-in transport. */
export async function __downloadAsrModelForVerify(
  entry: AsrModelEntry,
  cacheDir: string,
  download: typeof downloadModelFile,
): Promise<AsrDownloadTask> {
  const task = newDownloadTask(entry);
  await downloadAsrModel(entry, task, cacheDir, download);
  return task;
}
