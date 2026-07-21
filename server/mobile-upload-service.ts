import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isSafeUploadName, uploadDir } from './media-dir.ts';

const DEFAULT_SESSION_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac',
};

const MIME_EXTENSION: Record<string, string> = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/heic': '.heic', 'image/heif': '.heif',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/flac': '.flac',
};

export interface MobileUploadRecord {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  path: string;
  createdAt: number;
}

export interface MobileUploadSessionSnapshot {
  id: string;
  urls: string[];
  expiresAt: number;
  files: MobileUploadRecord[];
}

interface MobileUploadSession extends MobileUploadSessionSnapshot {
  token: string;
  locale: MobilePageLocale;
  closing: boolean;
  timer: NodeJS.Timeout;
  activeUploads: Set<Promise<void>>;
}

type MobilePageLocale = 'zh' | 'en';

interface MobileUploadServiceOptions {
  bindHost?: string;
  addresses?: () => string[];
  uploadDirectory?: () => string;
  maxBytes?: number;
  sessionTtlMs?: number;
  afterSave?: (name: string, filePath: string, mime: string) => Promise<void>;
  log?: (message: string) => void;
}

class UploadError extends Error {
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

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'session not found or expired' });
}

function contentLength(req: IncomingMessage): number | null {
  const value = req.headers['content-length'];
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function mediaDescriptor(name: string, rawMime: string | undefined): { extension: string; mime: string } | null {
  const mime = (rawMime ?? '').split(';')[0]!.trim().toLowerCase();
  const extension = extensionOf(name);
  if (EXTENSION_MIME[extension]) return { extension, mime: EXTENSION_MIME[extension] };
  const fromMime = MIME_EXTENSION[mime];
  return fromMime ? { extension: fromMime, mime } : null;
}

async function streamUpload(req: IncomingMessage, destination: string, maxBytes: number): Promise<number> {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new UploadError(413, 'file too large') : null, chunk);
    },
  });
  try {
    await pipeline(req as Readable, limiter, createWriteStream(destination));
    return bytes;
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

function matchesMediaSignature(bytes: Buffer, mime: string): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const text = (start: number, length: number) => bytes.subarray(start, start + length).toString('ascii');
  const isoBrand = bytes.length >= 12 && text(4, 4) === 'ftyp' ? text(8, 24) : '';
  if (mime === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mime === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === 'image/gif') return text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a';
  if (mime === 'image/webp') return text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP';
  if (mime === 'image/avif') return /avif|avis/.test(isoBrand);
  if (mime === 'image/heic' || mime === 'image/heif') return /heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(isoBrand);
  if (mime === 'video/mp4' || mime === 'video/quicktime' || mime === 'audio/mp4') return Boolean(isoBrand);
  if (mime === 'video/webm') return starts(0x1a, 0x45, 0xdf, 0xa3);
  if (mime === 'audio/mpeg') return text(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (mime === 'audio/wav') return text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE';
  if (mime === 'audio/aac') return bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
  if (mime === 'audio/ogg' || mime === 'audio/opus') return text(0, 4) === 'OggS';
  if (mime === 'audio/flac') return text(0, 4) === 'fLaC';
  return false;
}

async function validateMediaSignature(path: string, mime: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return matchesMediaSignature(buffer.subarray(0, bytesRead), mime);
  } finally {
    await file.close();
  }
}

function mobilePage(locale: MobilePageLocale): string {
  const en = locale === 'en';
  const copy = en ? {
    pageTitle: 'Upload from phone', title: 'Send media to OpenChatCut',
    hint: 'Choose video, images, or audio from your phone. Keep both devices on the same local network.',
    choose: 'Choose media', multiple: 'Multiple files supported. Keep this page open until all uploads finish.',
    waiting: 'Waiting to upload', sent: 'Sent', failed: 'Upload failed', interrupted: 'Network interrupted',
  } : {
    pageTitle: '手机传素材', title: '发送素材到 OpenChatCut',
    hint: '选择手机里的视频、图片或音频。电脑和手机需连接同一局域网。',
    choose: '选择素材', multiple: '支持多选，页面保持打开直到全部完成',
    waiting: '等待上传', sent: '已发送', failed: '上传失败', interrupted: '网络中断',
  };
  const scriptCopy = JSON.stringify({ waiting: copy.waiting, sent: copy.sent, failed: copy.failed, interrupted: copy.interrupted });
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenChatCut · ${copy.pageTitle}</title><style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0b0c;color:#f5f5f5}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box}.card{width:min(460px,100%);background:#171719;border:1px solid #303034;border-radius:18px;padding:24px;box-sizing:border-box;box-shadow:0 24px 80px #0008}h1{font-size:23px;margin:0 0 8px}.hint{color:#aaa;margin:0 0 20px;line-height:1.5}.drop{display:grid;place-items:center;min-height:160px;border:1px dashed #555;border-radius:14px;background:#111;padding:18px;text-align:center}.pick{display:inline-block;background:#f26a2e;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700}input{display:none}.status{display:grid;gap:8px;margin-top:16px}.row{background:#202024;border-radius:9px;padding:10px 12px;overflow-wrap:anywhere}.ok{color:#65d6a3}.bad{color:#ff7b72}small{color:#888}</style></head>
<body><main class="card"><h1>${copy.title}</h1><p class="hint">${copy.hint}</p><label class="drop"><span><span class="pick">${copy.choose}</span><br><small>${copy.multiple}</small></span><input id="files" type="file" multiple accept="video/*,image/jpeg,image/png,image/gif,image/webp,image/avif,image/heic,image/heif,.heic,.heif,audio/*"></label><section id="status" class="status" aria-live="polite"></section></main>
<script>const COPY=${scriptCopy},input=document.querySelector('#files'),status=document.querySelector('#status');
function row(name){const el=document.createElement('div');el.className='row';el.textContent=name+' · '+COPY.waiting;status.prepend(el);return el}
function upload(file){const el=row(file.name);return new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('POST',location.pathname+'/upload?name='+encodeURIComponent(file.name));xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');xhr.upload.onprogress=e=>{if(e.lengthComputable)el.textContent=file.name+' · '+Math.round(e.loaded/e.total*100)+'%'};xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300){el.classList.add('ok');el.textContent=file.name+' · '+COPY.sent}else{el.classList.add('bad');el.textContent=file.name+' · '+COPY.failed}resolve()};xhr.onerror=()=>{el.classList.add('bad');el.textContent=file.name+' · '+COPY.interrupted;resolve()};xhr.send(file)})}
input.addEventListener('change',async()=>{for(const file of input.files)await upload(file);input.value=''})</script></body></html>`;
}

export function localIpv4Addresses(): string[] {
  const virtual = /utun|tun|tap|tailscale|docker|bridge|veth|vmnet|virtual|loopback/i;
  const preferred = /^(?:en[01]|wi-?fi|wlan|ethernet)/i;
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, items]) => (items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => ({ name, address: item.address })));
  const score = ({ name, address }: { name: string; address: string }) =>
    (preferred.test(name) ? 100 : 0) + (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address) ? 20 : 0)
    - (virtual.test(name) ? 200 : 0);
  return [...new Map(candidates.map((candidate) => [candidate.address, candidate])).values()]
    .sort((a, b) => score(b) - score(a) || a.address.localeCompare(b.address))
    .map((candidate) => candidate.address);
}

export class MobileUploadService {
  private readonly sessions = new Map<string, MobileUploadSession>();
  private server: Server | null = null;
  private port: number | null = null;
  private starting: Promise<void> | null = null;
  private readonly options: Required<Pick<MobileUploadServiceOptions,
    'bindHost' | 'addresses' | 'uploadDirectory' | 'maxBytes' | 'sessionTtlMs' | 'log'>> &
    Pick<MobileUploadServiceOptions, 'afterSave'>;

  constructor(options: MobileUploadServiceOptions = {}) {
    this.options = {
      bindHost: options.bindHost ?? '0.0.0.0',
      addresses: options.addresses ?? localIpv4Addresses,
      uploadDirectory: options.uploadDirectory ?? uploadDir,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      afterSave: options.afterSave,
      log: options.log ?? (() => undefined),
    };
  }

  async createSession(locale: MobilePageLocale = 'zh'): Promise<MobileUploadSessionSnapshot> {
    const addresses = this.options.addresses();
    if (addresses.length === 0) throw new Error('no LAN IPv4 address available');
    await this.ensureServer();
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.options.sessionTtlMs;
    const urls = addresses.map((address) => `http://${address}:${this.port}/s/${token}`);
    const timer = setTimeout(() => { void this.closeSession(id); }, this.options.sessionTtlMs);
    timer.unref();
    const session: MobileUploadSession = { id, token, locale, urls, expiresAt, files: [], closing: false, timer, activeUploads: new Set() };
    this.sessions.set(id, session);
    return this.snapshot(session);
  }

  getSession(id: string): MobileUploadSessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) void this.closeSession(id);
      return null;
    }
    return this.snapshot(session);
  }

  async closeSession(id: string): Promise<MobileUploadSessionSnapshot | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.closing = true;
    clearTimeout(session.timer);
    await Promise.allSettled([...session.activeUploads]);
    const snapshot = this.snapshot(session);
    this.sessions.delete(id);
    if (this.sessions.size === 0) await this.closeServer();
    return snapshot;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) clearTimeout(session.timer);
    this.sessions.clear();
    await this.closeServer();
  }

  private snapshot(session: MobileUploadSession): MobileUploadSessionSnapshot {
    return { id: session.id, urls: [...session.urls], expiresAt: session.expiresAt, files: session.files.map((file) => ({ ...file })) };
  }

  private async ensureServer(): Promise<void> {
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.once('error', reject);
      server.listen(0, this.options.bindHost, () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('mobile upload server failed to bind')); return; }
        this.server = server;
        this.port = address.port;
        resolve();
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private sessionByToken(token: string): MobileUploadSession | null {
    for (const session of this.sessions.values()) {
      if (session.token === token && !session.closing && session.expiresAt > Date.now()) return session;
    }
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = /^\/s\/([A-Za-z0-9_-]+)(\/upload)?$/.exec(url.pathname);
      if (!match) { sendNotFound(res); return; }
      const session = this.sessionByToken(match[1]!);
      if (!session) { sendNotFound(res); return; }
      if (!match[2] && req.method === 'GET') { this.sendPage(res, session.locale); return; }
      if (match[2] && req.method === 'POST') {
        const upload = this.receiveUpload(session, url, req, res);
        session.activeUploads.add(upload);
        try { await upload; } finally { session.activeUploads.delete(upload); }
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
    } catch (error) {
      const status = error instanceof UploadError ? error.status : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private sendPage(res: ServerResponse, locale: MobilePageLocale): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.end(mobilePage(locale));
  }

  private async receiveUpload(
    session: MobileUploadSession,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const declared = contentLength(req);
    if (declared === 0) throw new UploadError(400, 'empty body');
    if (declared != null && declared > this.options.maxBytes) throw new UploadError(413, 'file too large');
    const originalName = (url.searchParams.get('name') ?? '').replace(/^.*[\\/]/, '').slice(0, 180);
    if (!isSafeUploadName(originalName)) throw new UploadError(400, 'unsafe or missing name');
    const descriptor = mediaDescriptor(originalName, req.headers['content-type']);
    if (!descriptor) throw new UploadError(415, 'unsupported media type');
    const storedName = `${randomUUID()}${descriptor.extension}`;
    const directory = this.options.uploadDirectory();
    const partPath = join(directory, `.${storedName}.part`);
    const finalPath = join(directory, storedName);
    await mkdir(directory, { recursive: true });
    const bytes = await streamUpload(req, partPath, this.options.maxBytes);
    if (bytes === 0) { await unlink(partPath).catch(() => undefined); throw new UploadError(400, 'empty body'); }
    if (!await validateMediaSignature(partPath, descriptor.mime)) {
      await unlink(partPath).catch(() => undefined);
      throw new UploadError(415, 'media content does not match its declared type');
    }
    await rename(partPath, finalPath);
    try {
      await this.options.afterSave?.(storedName, finalPath, descriptor.mime);
    } catch (error) {
      this.options.log(`[mobile-upload] cloud mirror failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record: MobileUploadRecord = {
      id: randomUUID(), name: originalName, mime: descriptor.mime, bytes,
      path: `/media/uploads/${storedName}`, createdAt: Date.now(),
    };
    session.files = [...session.files, record];
    sendJson(res, 200, record);
  }
}
