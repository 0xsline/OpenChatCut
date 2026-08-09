import type { Plugin } from 'vite';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MODEL_PACKS,
  modelPackDefinition,
  type ModelPackCatalogEntry,
  type ModelPackDefinition,
  type ModelPackFile,
  type ModelPackId,
  type ModelPackTask,
} from '../../shared/model-packs/catalog.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { downloadModelFile, modelCacheDir } from './hf-proxy.ts';
import { recoverDirectorySwap, replaceDirectoryAtomically } from './model-pack-install.ts';

const MAX_JSON_BYTES = 8 * 1024;

interface MutableTask {
  id: ModelPackId;
  status: ModelPackTask['status'];
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  error?: string;
}

interface PackInspection {
  installed: boolean;
  bytes: number;
  error?: string;
}

const tasks = new Map<ModelPackId, MutableTask>();
const inspections = new Map<ModelPackId, { fingerprint: string; result: PackInspection }>();
const controllers = new Map<ModelPackId, AbortController>();
const downloadFlights = new Map<ModelPackId, Promise<void>>();

let recoveryFlight: Promise<void> | null = null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function modelPackMutationRequestError(
  headers: IncomingHttpHeaders,
): { status: number; error: string } | null {
  const contentType = String(headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') return { status: 415, error: 'content-type must be application/json' };
  const fetchSite = String(headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return { status: 403, error: 'cross-site requests are not allowed' };
  }
  const origin = String(headers.origin ?? '').trim();
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    const trusted = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host === String(headers.host ?? '');
    return trusted ? null : { status: 403, error: 'untrusted request origin' };
  } catch {
    return { status: 403, error: 'untrusted request origin' };
  }
}

function requireModelPackMutationCredential(req: IncomingMessage, res: ServerResponse): boolean {
  if (editorCredentialAuthorized(req, true)) return true;
  req.resume();
  sendJson(res, 401, { error: 'editor credential required' });
  return false;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) {
      reject(new Error('Request body is too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
    } catch {
      reject(new Error('Request body must be valid JSON'));
    }
  });
  req.on('error', reject);
  return promise;
}

function packRoot(pack: ModelPackDefinition): string {
  return join(modelCacheDir(), pack.modelId);
}

function stagingRoot(pack: ModelPackDefinition): string {
  return join(modelCacheDir(), '.model-pack-staging', pack.id);
}
function backupRoot(pack: ModelPackDefinition): string {
  return `${stagingRoot(pack)}.backup`;
}


async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectPack(pack: ModelPackDefinition): Promise<PackInspection> {
  const stats: Array<{ size: number; mtimeMs: number; ctimeMs: number }> = [];
  for (const file of pack.files) {
    try {
      const info = await stat(join(packRoot(pack), file.path));
      if (!info.isFile()) return { installed: false, bytes: 0, error: `${file.path} is not a file` };
      if (info.size !== file.sizeBytes) {
        return { installed: false, bytes: 0, error: `${file.path} has an unexpected size` };
      }
      stats.push({ size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: false, bytes: 0 };
      throw error;
    }
  }
  const fingerprint = stats.map((item) => `${item.size}:${item.mtimeMs}:${item.ctimeMs}`).join('|');
  const cached = inspections.get(pack.id);
  if (cached?.fingerprint === fingerprint) return cached.result;
  for (const file of pack.files) {
    const actual = await sha256(join(packRoot(pack), file.path));
    if (actual !== file.sha256) {
      const result = { installed: false, bytes: 0, error: `${file.path} failed SHA-256 verification` };
      inspections.set(pack.id, { fingerprint, result });
      return result;
    }
  }
  const result = { installed: true, bytes: stats.reduce((sum, item) => sum + item.size, 0) };
  inspections.set(pack.id, { fingerprint, result });
  return result;
}

function taskSnapshot(task: MutableTask): ModelPackTask {
  return { ...task };
}

async function catalogEntry(pack: ModelPackDefinition): Promise<ModelPackCatalogEntry> {
  const task = tasks.get(pack.id);
  const inspection = await inspectPack(pack);
  const status = task?.status === 'downloading'
    ? 'downloading'
    : inspection.installed
      ? 'installed'
      : task?.status === 'error' || inspection.error
        ? 'error'
        : 'absent';
  const error = task?.error ?? inspection.error;
  return {
    ...pack,
    status,
    installedBytes: inspection.bytes,
    ...(task ? { task: taskSnapshot(task) } : {}),
    ...(error ? { error } : {}),
  };
}

async function catalog(): Promise<readonly ModelPackCatalogEntry[]> {
  return Promise.all(MODEL_PACKS.map(catalogEntry));
}

async function verifyDownloadedFile(
  path: string,
  file: ModelPackFile,
  removeInvalid = true,
): Promise<void> {
  const info = await stat(path);
  if (info.size !== file.sizeBytes) {
    if (removeInvalid) await unlink(path).catch(() => undefined);
    throw new Error(`${file.path} size mismatch: expected ${file.sizeBytes}, got ${info.size}`);
  }
  const actual = await sha256(path);
  if (actual !== file.sha256) {
    if (removeInvalid) await unlink(path).catch(() => undefined);
    throw new Error(`${file.path} SHA-256 mismatch: expected ${file.sha256}, got ${actual}`);
  }
}

async function stageFile(
  pack: ModelPackDefinition,
  file: ModelPackFile,
  stage: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const source = join(packRoot(pack), file.path);
  const destination = join(stage, file.path);
  await mkdir(dirname(destination), { recursive: true });
  if (existsSync(source)) {
    try {
      await verifyDownloadedFile(source, file, false);
      await copyFile(source, destination);
      onProgress(file.sizeBytes);
      return;
    } catch {
      // Keep the installed path untouched; download a verified replacement into staging.
    }
  }
  await downloadModelFile(
    { modelId: pack.modelId, revision: pack.revision, filePath: file.path },
    destination,
    { signal, onProgress },
  );
  await verifyDownloadedFile(destination, file);
}

async function verifyStagedPack(pack: ModelPackDefinition, stage: string): Promise<void> {
  for (const file of pack.files) await verifyDownloadedFile(join(stage, file.path), file);
}

async function installStagedPack(pack: ModelPackDefinition, stage: string): Promise<void> {
  await replaceDirectoryAtomically(stage, packRoot(pack), backupRoot(pack));
}

async function removePackFiles(pack: ModelPackDefinition): Promise<void> {
  const root = packRoot(pack);
  for (const file of pack.files) await unlink(join(root, file.path)).catch(() => undefined);
  const directories = [...new Set(pack.files.map((file) => dirname(file.path)))]
    .filter((path) => path !== '.')
    .sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    await rm(join(root, directory), { recursive: false }).catch(() => undefined);
  }
  await rm(root, { recursive: false }).catch(() => undefined);
}
async function recoverInterruptedInstall(pack: ModelPackDefinition): Promise<void> {
  await recoverDirectorySwap(packRoot(pack), backupRoot(pack));
}
async function ensureRecovered(): Promise<void> {
  if (!recoveryFlight) {
    const attempt = Promise.all(MODEL_PACKS.map(async (pack) => {
      await recoverInterruptedInstall(pack);
      await rm(stagingRoot(pack), { recursive: true, force: true });
      inspections.delete(pack.id);
    })).then(() => undefined);
    recoveryFlight = attempt.catch((error) => {
      recoveryFlight = null;
      throw error;
    });
  }
  return recoveryFlight;
}


async function runDownload(
  pack: ModelPackDefinition,
  task: MutableTask,
  signal: AbortSignal,
): Promise<void> {
  const stage = stagingRoot(pack);
  try {
    await rm(stage, { recursive: true, force: true });
    let completedBytes = 0;
    for (const file of pack.files) {
      await stageFile(pack, file, stage, signal, (bytes) => {
        task.bytesDone = Math.min(task.bytesTotal, completedBytes + bytes);
      });
      completedBytes += file.sizeBytes;
      task.filesDone += 1;
      task.bytesDone = completedBytes;
    }
    if (signal.aborted) throw signal.reason;
    await verifyStagedPack(pack, stage);
    if (signal.aborted) throw signal.reason;
    await installStagedPack(pack, stage);
    inspections.delete(pack.id);
    const installed = await inspectPack(pack);
    if (!installed.installed) throw new Error(installed.error || 'Pack verification failed after install');
    task.status = 'installed';
    task.bytesDone = task.bytesTotal;
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    inspections.delete(pack.id);
    task.status = 'error';
    task.error = errorMessage(error);
  }
}

async function startDownload(id: string): Promise<ModelPackTask> {
  const pack = modelPackDefinition(id);
  if (!pack) throw new Error(`Unknown model pack: ${id || '(empty)'}`);
  const current = tasks.get(pack.id);
  if (current?.status === 'downloading') return taskSnapshot(current);
  const task: MutableTask = {
    id: pack.id,
    status: 'downloading',
    bytesDone: 0,
    bytesTotal: pack.sizeBytes,
    filesDone: 0,
    filesTotal: pack.files.length,
  };
  tasks.set(pack.id, task);
  try {
    await ensureRecovered();
    const installed = await inspectPack(pack);
    if (!installed.installed) {
      const controller = new AbortController();
      controllers.set(pack.id, controller);
      const flight = runDownload(pack, task, controller.signal).finally(() => {
        if (controllers.get(pack.id) === controller) controllers.delete(pack.id);
        downloadFlights.delete(pack.id);
      });
      downloadFlights.set(pack.id, flight);
      void flight;
      return taskSnapshot(task);
    }
    task.status = 'installed';
    task.bytesDone = pack.sizeBytes;
    task.filesDone = pack.files.length;
  } catch (error) {
    task.status = 'error';
    task.error = errorMessage(error);
  }
  return taskSnapshot(task);
}
async function cancelDownload(id: string): Promise<void> {
  const pack = modelPackDefinition(id);
  if (!pack) throw new Error(`Unknown model pack: ${id || '(empty)'}`);
  const task = tasks.get(pack.id);
  const controller = controllers.get(pack.id);
  if (task?.status !== 'downloading' || !controller) return;
  controller.abort(new Error('Model download cancelled'));
  await downloadFlights.get(pack.id);
  const current = tasks.get(pack.id);
  if (current?.status !== 'installed' && current === task) tasks.delete(pack.id);
  await rm(stagingRoot(pack), { recursive: true, force: true });
  inspections.delete(pack.id);
}


async function deletePack(id: string): Promise<void> {
  const pack = modelPackDefinition(id);
  if (!pack) throw new Error(`Unknown model pack: ${id || '(empty)'}`);
  await ensureRecovered();
  if (tasks.get(pack.id)?.status === 'downloading') throw new Error(`Model pack ${id} is downloading`);
  await removePackFiles(pack);
  await rm(stagingRoot(pack), { recursive: true, force: true });
  await rm(backupRoot(pack), { recursive: true, force: true });
  tasks.delete(pack.id);
  inspections.delete(pack.id);
}

async function handleDownloadRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireModelPackMutationCredential(req, res)) return;
  const rejected = modelPackMutationRequestError(req.headers);
  if (rejected) {
    sendJson(res, rejected.status, { error: rejected.error });
    return;
  }
  const body = await readJson(req);
  sendJson(res, 202, { task: await startDownload(String(body.id ?? '')) });
}

async function handleCancelRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireModelPackMutationCredential(req, res)) return;
  const rejected = modelPackMutationRequestError(req.headers);
  if (rejected) {
    sendJson(res, rejected.status, { error: rejected.error });
    return;
  }
  const body = await readJson(req);
  await cancelDownload(String(body.id ?? ''));
  sendJson(res, 200, { ok: true });
}

async function handleDeleteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireModelPackMutationCredential(req, res)) return;
  const rejected = modelPackMutationRequestError(req.headers);
  if (rejected) {
    sendJson(res, rejected.status, { error: rejected.error });
    return;
  }
  const body = await readJson(req);
  await deletePack(String(body.id ?? ''));
  sendJson(res, 200, { ok: true });
}

export async function handleModelPackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (pathname === '/api/model-packs' && req.method === 'GET') {
    await ensureRecovered();
    sendJson(res, 200, { packs: await catalog() });
    return;
  }
  if (pathname === '/api/model-packs/download' && req.method === 'POST') {
    await handleDownloadRequest(req, res);
    return;
  }
  const taskMatch = /^\/api\/model-packs\/(?:download|tasks)\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (taskMatch && req.method === 'GET') {
    const pack = modelPackDefinition(taskMatch[1]);
    if (!pack) throw new Error(`Unknown model pack: ${taskMatch[1]}`);
    const task = tasks.get(pack.id);
    sendJson(res, 200, { task: task ? taskSnapshot(task) : null });
    return;
  }
  if (pathname === '/api/model-packs/cancel' && req.method === 'POST') {
    await handleCancelRequest(req, res);
    return;
  }
  if (pathname === '/api/model-packs/delete' && req.method === 'POST') {
    await handleDeleteRequest(req, res);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

export function modelPacksPlugin(): Plugin {
  return {
    name: 'openchatcut-model-packs',
    configureServer(server) {
      void ensureRecovered().catch((error) => {
        server.config.logger.error(`[model-packs] recovery failed: ${errorMessage(error)}`);
      });
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        if (!pathname.startsWith('/api/model-packs')) {
          next();
          return;
        }
        void handleModelPackRequest(req, res, pathname)
          .catch((error) => sendJson(res, 400, { error: errorMessage(error) }));
      });
    },
  };
}

export function __resetModelPackState(): void {
  for (const controller of controllers.values()) controller.abort(new Error('Model pack state reset'));
  controllers.clear();
  downloadFlights.clear();
  tasks.clear();
  inspections.clear();
  recoveryFlight = null;
}
