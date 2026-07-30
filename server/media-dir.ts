// 素材保存目录(server-only):MEDIA_DIR 让用户把上传/生成素材改存
// 任意本机目录(如外置硬盘)。URL 恒为同源 /media/uploads/<name>,与物理位置解耦——
// 自定义目录在 public/ 之外时由 upload 插件的中间件直接流出(带 Range,视频 seek 必需);
// 读取兜底链:自定义目录 → 旧默认目录 → R2 回源。切换目录时把旧目录素材复制到
// 新目录(保留原文件),渲染导出的单目录 symlink 才能看到全部素材。
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getKey, type KeyName } from './keystore.ts';

export const DEFAULT_UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');

/** 上传文件名安全判定(全部读写方共用):单段(无路径分隔)、不以点开头(排除
 * 穿越与 .part/.sync 中间态)、无控制符。允许中文等 Unicode 名(实际存在于素材库,
 * `\w` 白名单会把它们漏给 SPA 假 200)。 */
export function isSafeUploadName(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return true;
}

/** 展开 ~/ 并要求绝对路径;非法(相对路径)返回 null。 */
export function expandMediaDir(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const expanded = t === '~' ? homedir() : t.replace(/^~(?=\/)/, homedir());
  if (!isAbsolute(expanded)) return null;
  return resolve(expanded);
}

/** 当前素材保存目录:MEDIA_DIR 未设或非法时回默认 public/media/uploads。 */
export function uploadDir(): string {
  return expandMediaDir(getKey('MEDIA_DIR')) ?? DEFAULT_UPLOAD_DIR;
}

export function isCustomUploadDir(): boolean {
  return uploadDir() !== DEFAULT_UPLOAD_DIR;
}

/** 上传文件的真实磁盘路径:自定义目录优先,旧默认目录兜底;都没有 → null。 */
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

// ── 直接流出磁盘文件(自定义目录在 public/ 之外,Vite 静态服务够不到) ──────────

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

/** GET/HEAD 一个磁盘文件,支持单段 Range(206/416,视频 seek 依赖)。 */
export async function serveDiskFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const info = await stat(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') start = Math.max(0, info.size - Number(range[2]));  // bytes=-N 后缀段
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

// ── 启动同步 ─────────────────────────────────────────────────────────────

/** 把旧目录中目标缺少的素材复制过去(原文件保留;.sync 中转原子落名)。
 * 幂等,按文件名跳过已有；返回成功复制数。 */
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

/** 兼容启动时已保存的 MEDIA_DIR:把默认目录里缺的老素材补到当前自定义目录。 */
export async function syncLegacyUploads(log: (msg: string) => void): Promise<void> {
  if (!isCustomUploadDir()) return;
  try {
    await syncUploadDirectories(DEFAULT_UPLOAD_DIR, uploadDir(), log);
  } catch (err) {
    log(`[media-dir] 老素材同步失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 测试连接探针 ─────────────────────────────────────────────────────────

interface DirProbeBody { ok: boolean; note?: string; error?: string; }

/** 本地保存目录探针:恒 200 + JSON {ok,note|error}(不是网络请求,失败也不该走
 * classifyStatus 的 HTTP 文案)——postCheck 取 error,okText 取 note。 */
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
