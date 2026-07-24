// Material saving directory (server-only): MEDIA_DIR allows users to save uploaded/generated materials
// Any local directory (such as an external hard drive). The URL is always from the same origin /media/uploads/<name>, decoupled from the physical location——
// When the custom directory is outside public/, it is directly flowed out by the middleware of the upload plug-in (with Range, video seek required);
// Read the backend chain: custom directory → old default directory → R2 back to the source. When switching directories, copy the old directory materials to
// Create a new directory (keep the original files) and render the exported single directory symlink to see all the materials.
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getKey, type KeyName } from './keystore.ts';

export const DEFAULT_UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');

/** Upload file name security determination(Shared by all readers and writers):single segment(No path separation), does not start with a dot(exclude
 * time travel and .part/.sync intermediate state), no control character. Allow Chinese, etc. Unicode name(actually exists in the material library,
 * `\w` Whitelisting will leak them to SPA false 200)。 */
export function isSafeUploadName(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return true;
}

/** Expand ~/ and require absolute path;illegal(relative path)Return null。 */
export function expandMediaDir(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const expanded = t === '~' ? homedir() : t.replace(/^~(?=\/)/, homedir());
  if (!isAbsolute(expanded)) return null;
  return resolve(expanded);
}

/** Current material storage directory:MEDIA_DIR Return to default if not set or illegal public/media/uploads。 */
export function uploadDir(): string {
  return expandMediaDir(getKey('MEDIA_DIR')) ?? DEFAULT_UPLOAD_DIR;
}

export function isCustomUploadDir(): boolean {
  return uploadDir() !== DEFAULT_UPLOAD_DIR;
}

/** The real disk path of the uploaded file:Customized directories take priority, and the old default directories are ignored.;None → null。 */
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

// ── Directly export disk files (the custom directory is outside public/ and cannot be reached by Vite static service) ──────────

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

/** GET/HEAD a disk file,Support single segment Range(206/416,video seek Depend on)。 */
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

// ── Start synchronization ───────────────────────────────────────────────────────

/** Copy the missing materials in the old directory to the target(Original files retained;.sync Transit Atomic Name)。
 * Idempotent,Skip existing ones by file name; return the number of successful copies. */
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
  if (copied > 0) log(`[media-dir] Migrated ${copied} materials:${source} → ${target}`);
  return copied;
}

/** Compatible with saved files at startup MEDIA_DIR:Add old materials missing from the default directory to the current custom directory. */
export async function syncLegacyUploads(log: (msg: string) => void): Promise<void> {
  if (!isCustomUploadDir()) return;
  try {
    await syncUploadDirectories(DEFAULT_UPLOAD_DIR, uploadDir(), log);
  } catch (err) {
    log(`[media-dir] Old material synchronization failed:${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Test connection probe ────────────────────────────────────────────────────

interface DirProbeBody { ok: boolean; note?: string; error?: string; }

/** Local save directory probe:constant 200 + JSON {ok,note|error}(Not a network request,You shouldn’t leave even if you fail
 * classifyStatus of HTTP copywriting)——postCheck take error,okText take note。 */
export async function mediaDirProbe(get: (name: KeyName) => string): Promise<Response> {
  const body = await checkMediaDir(get('MEDIA_DIR'));
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

export async function checkMediaDir(raw: string): Promise<DirProbeBody> {
  if (!raw.trim()) return { ok: true, note: `not set · Use default directory ${DEFAULT_UPLOAD_DIR}` };
  const dir = expandMediaDir(raw);
  if (!dir) return { ok: false, error: 'Must be an absolute path (available ~/ beginning)' };
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.cc-dir-probe-${process.pid}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    return { ok: true, note: `Directory is writable · ${dir}` };
  } catch (err) {
    return { ok: false, error: `Directory is not writable · ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function mediaDirPostCheck(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as DirProbeBody;
    return body.ok ? null : (body.error ?? 'Directory check failed');
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
