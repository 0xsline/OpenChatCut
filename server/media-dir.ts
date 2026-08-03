// Asset storage directory (server-only): MEDIA_DIR allows users to save uploaded/generated assets
// Any local directory (such as an external hard drive). The URL is always from the same origin /media/uploads/<name>, decoupled from the physical location —
// When the custom directory is outside public/, it is directly flowed out by the middleware of the upload plugin (with Range, video seek required);
// Read the backend chain: custom directory → old default directory → R2 back to the source. When switching directories, copy the old directory assets to
// Create a new directory (keep the original files) and render the exported single directory symlink to see all the assets.
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getKey, type KeyName } from './keystore.ts';
import { getUploadObjectToFile, r2Config } from './r2.ts';

export const DEFAULT_UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');

/** Security judgment of uploaded file name (shared by all readers and writers): single paragraph (no path separation), not starting with a dot (exclude
 * Traversal and .part/.sync intermediate state), no control characters. Allows Chinese and other Unicode names (actually existing in the asset library,
 * `\w` Whitelisting will leak them to SPA false 200). */
export function isSafeUploadName(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

/** Expand ~/ and require an absolute path; illegal (relative path) returns null. */
export function expandMediaDir(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const expanded = t === '~' ? homedir() : t.replace(/^~(?=\/)/, homedir());
  if (!isAbsolute(expanded)) return null;
  return resolve(expanded);
}

/** The current asset saving directory: MEDIA_DIR will default to public/media/uploads if it is not set or is illegal. */
export function uploadDir(): string {
  return expandMediaDir(getKey('MEDIA_DIR')) ?? DEFAULT_UPLOAD_DIR;
}

export function isCustomUploadDir(): boolean {
  return uploadDir() !== DEFAULT_UPLOAD_DIR;
}

/** The real disk path of the uploaded file: custom directory first, old default directory; none → null. */
export function resolveUploadFile(name: string): string | null {
  if (!isSafeUploadName(name)) return null;
  const dir = uploadDir();
  const dirs = dir === DEFAULT_UPLOAD_DIR ? [dir] : [dir, DEFAULT_UPLOAD_DIR];
  for (const d of dirs) {
    const file = join(d, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export interface ResolvedUploadFile {
  file: string;
  contentType: string;
  bytes: number;
  cached: boolean;
}

export interface UploadHydrationDependencies {
  resolveLocal: (name: string) => string | null;
  cloudAvailable: () => boolean;
  uploadDirectory: () => string;
  downloadToFile: typeof getUploadObjectToFile;
}

const defaultUploadHydrationDependencies: UploadHydrationDependencies = {
  resolveLocal: resolveUploadFile,
  cloudAvailable: () => r2Config() !== null,
  uploadDirectory: uploadDir,
  downloadToFile: getUploadObjectToFile,
};
const uploadHydrations = new Map<string, Promise<ResolvedUploadFile | null>>();
const uploadMutationQueues = new Map<string, Promise<void>>();

/** Serialize every local/cloud publication for one upload object identity. */
export function enqueueUploadMutation<T>(name: string, work: () => Promise<T>): Promise<T> {
  const previous = uploadMutationQueues.get(name) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.then(() => undefined, () => undefined);
  uploadMutationQueues.set(name, settled);
  void settled.finally(() => {
    if (uploadMutationQueues.get(name) === settled) uploadMutationQueues.delete(name);
  });
  return run;
}

async function resolveOrHydrateUploadFileOnce(
  name: string,
  dependencies: UploadHydrationDependencies,
  signal?: AbortSignal,
): Promise<ResolvedUploadFile | null> {
  signal?.throwIfAborted();
  const local = dependencies.resolveLocal(name);
  if (local) {
    try {
      const info = await stat(local);
      signal?.throwIfAborted();
      if (info.isFile()) {
        return { file: local, contentType: mimeFor(name), bytes: info.size, cached: true };
      }
    } catch (error) {
      signal?.throwIfAborted();
      // A concurrent removal is a cache miss; let the R2 read-through restore it.
    }
  }

  if (!dependencies.cloudAvailable()) return null;
  const directory = dependencies.uploadDirectory();
  await mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const partPath = join(directory, `.${name}.part`);
  const finalPath = join(directory, name);
  let published = false;
  try {
    const object = await dependencies.downloadToFile(name, partPath, { signal });
    signal?.throwIfAborted();
    if (!object) return null;
    const contentType = object.contentType.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType === 'text/html') return null;
    await rename(partPath, finalPath);
    signal?.throwIfAborted();
    published = true;
    return {
      file: finalPath,
      contentType: object.contentType,
      bytes: object.bytes,
      cached: false,
    };
  } finally {
    await unlink(partPath).catch(() => undefined);
    if (!published && signal?.aborted) await unlink(finalPath).catch(() => undefined);
  }
}

/** Resolve locally or share one atomic R2 hydration among all concurrent readers of the same safe name. */
export function resolveOrHydrateUploadFile(
  name: string,
  dependencies: UploadHydrationDependencies = defaultUploadHydrationDependencies,
  signal?: AbortSignal,
): Promise<ResolvedUploadFile | null> {
  if (!isSafeUploadName(name)) return Promise.resolve(null);
  signal?.throwIfAborted();
  if (signal) {
    const queued = enqueueUploadMutation(
      name,
      () => resolveOrHydrateUploadFileOnce(name, dependencies, signal),
    );
    const deferred = Promise.withResolvers<ResolvedUploadFile | null>();
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      deferred.reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    queued.then(
      (value) => {
        cleanup();
        deferred.resolve(value);
      },
      (error: unknown) => {
        cleanup();
        deferred.reject(error);
      },
    );
    return deferred.promise;
  }
  const inFlight = uploadHydrations.get(name);
  if (inFlight) return inFlight;

  const shared = enqueueUploadMutation(
    name,
    () => resolveOrHydrateUploadFileOnce(name, dependencies),
  ).finally(() => {
    uploadHydrations.delete(name);
  });
  uploadHydrations.set(name, shared);
  return shared;
}

// ── Directly stream disk files (the custom directory is outside public/ and cannot be reached by Vite static service) ──────────

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  srt: 'application/x-subrip', vtt: 'text/vtt', txt: 'text/plain', json: 'application/json',
};

export function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** GET/HEAD A disk file, supports single segment Range (206/416, video seek dependent). */
export async function serveDiskFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const info = await stat(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') start = Math.max(0, info.size - Number(range[2]));  // bytes=-N suffix segment
    else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      res.end();
      return;
    }
    status = 206;
  }
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file, { start, end }).pipe(res);
}

// ── Start synchronization ────────────────────────────────────────────────────────

/** Copy the missing assets in the old directory (the original files are retained;.sync transfer atoms are dropped).
 * Idempotent, skip existing files by file name; return the number of successful copies.*/
export async function syncUploadDirectories(
  source: string,
  target: string,
  log: (msg: string) => void,
): Promise<number> {
  if (resolve(source) === resolve(target)) return 0;
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isSafeUploadName(entry.name)) continue;
    if (existsSync(join(target, entry.name))) continue;
    const part = join(target, `.${entry.name}.sync`);
    try {
      await copyFile(join(source, entry.name), part);
      await rename(part, join(target, entry.name));
      copied += 1;
    } catch (err) {
      await unlink(part).catch(() => undefined);
      throw err;
    }
  }
  if (copied > 0) log(`[media-dir] 已迁移 ${copied} 个素材:${source} → ${target}`);
  return copied;
}

/** Compatible with MEDIA_DIR saved at startup: add old assets missing in the default directory to the current custom directory.*/
export async function syncLegacyUploads(log: (msg: string) => void): Promise<void> {
  if (!isCustomUploadDir()) return;
  try {
    await syncUploadDirectories(DEFAULT_UPLOAD_DIR, uploadDir(), log);
  } catch (err) {
    log(`[media-dir] 老素材同步失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Test connection probe ────────────────────────────────────────────────────

interface DirProbeBody { ok: boolean; note?: string; error?: string; }

/** Local save directory probe: Heng 200 + JSON {ok,note|error} (not a network request, you should not leave if it fails
 * HTTP copy of classifyStatus) - postCheck takes error, okText takes note.*/
export async function mediaDirProbe(get: (name: KeyName) => string): Promise<Response> {
  const body = await checkMediaDir(get('MEDIA_DIR'));
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

export async function checkMediaDir(raw: string): Promise<DirProbeBody> {
  if (!raw.trim()) return { ok: true, note: `未设置 · 使用默认目录 ${DEFAULT_UPLOAD_DIR}` };
  const dir = expandMediaDir(raw);
  if (!dir) return { ok: false, error: '必须是绝对路径（可用 ~/ 开头）' };
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.cc-dir-probe-${process.pid}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    return { ok: true, note: `目录可写 · ${dir}` };
  } catch (err) {
    return { ok: false, error: `目录不可写 · ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function mediaDirPostCheck(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as DirProbeBody;
    return body.ok ? null : (body.error ?? '目录检查失败');
  } catch {
    return null;
  }
}

export function mediaDirOkText(bodyText: string): string | null {
  try {
    return (JSON.parse(bodyText) as DirProbeBody).note ?? null;
  } catch {
    return null;
  }
}
