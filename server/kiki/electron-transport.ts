// KikiVoice transport backed by Electron's `net` module bound to a persist:partition session.
// Cookies travel automatically (session-bound); TLS is Chromium's → passes Cloudflare (R2 spike validated).
// Desktop-only: browser-dev has no Electron session. `electron` is imported dynamically so this module
// never crashes a non-Electron import graph; it only fails if you actually call it outside Electron.

import type { Session, Net } from 'electron';
import { randomBytes } from 'node:crypto';
import type {
  KikiTransport,
  KikiResponse,
  KikiGetOptions,
  KikiPostFormOptions,
  KikiFilePart,
  KikiHeaders,
} from './types.ts';

export interface ElectronKikiTransportOptions {
  /** session.fromPartition('persist:kiki') — carries uuid+cf_clearance+fpestid. */
  getSession: () => Session;
  /** Must match the UA the login window used (cf_clearance binds IP+UA). */
  userAgent: string;
}

export class ElectronKikiTransport implements KikiTransport {
  private readonly opts: ElectronKikiTransportOptions;
  private netMod: Net | undefined;

  constructor(opts: ElectronKikiTransportOptions) {
    this.opts = opts;
  }

  private async net(): Promise<Net> {
    if (!this.netMod) {
      // Dynamic import: keeps this module importable in pure-Vite (browser-dev) where `electron` is absent.
      const electron = (await import('electron')) as typeof import('electron');
      this.netMod = electron.net;
    }
    return this.netMod;
  }

  get(url: string, opts: KikiGetOptions = {}): Promise<KikiResponse> {
    const fullUrl = opts.params
      ? `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(opts.params).toString()}`
      : url;
    return this.request('GET', fullUrl, undefined, opts.headers ?? {}, opts.timeoutMs);
  }

  postForm(
    url: string,
    fields: Record<string, string>,
    files: Record<string, KikiFilePart> = {},
    opts: KikiPostFormOptions = {},
  ): Promise<KikiResponse> {
    const { boundary, body } = buildMultipart(fields, files);
    const headers: KikiHeaders = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...opts.headers,
    };
    return this.request('POST', url, body, headers, opts.timeoutMs);
  }

  private async request(
    method: string,
    url: string,
    body: Buffer | undefined,
    headers: KikiHeaders,
    timeoutMs?: number,
  ): Promise<KikiResponse> {
    const net = await this.net();
    const session = this.opts.getSession();
    return new Promise((resolve, reject) => {
      const req = net.request({ url, method, session, useSessionCookies: true });
      req.setHeader('User-Agent', this.opts.userAgent);
      // HAR-confirmed: same-domain (kikivoice.ai apex) jsapi requests NEED Origin+Referer
      // (create-task returns degraded/empty response without them). Cross-domain (custom-voice-upload
      // subdomain) must drop them (ERR_BLOCKED_BY_CLIENT). GeeTest geevisit.com = different host.
      let isKikiApex = false;
      try { isKikiApex = new URL(url).host === 'kikivoice.ai'; } catch { /* invalid url */ }
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if ((lk === 'origin' || lk === 'referer') && !isKikiApex) continue;
        req.setHeader(k, v);
      }

      const chunks: Buffer[] = [];
      let status = 0;
      const respHeaders: KikiHeaders = {};
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timer = setTimeout(() => {
          try { req.abort(); } catch { /* noop */ }
          reject(new Error(`kiki transport timeout ${timeoutMs}ms (${method} ${url})`));
        }, timeoutMs);
      }

      req.on('response', (resp) => {
        status = resp.statusCode;
        for (const [k, v] of Object.entries(resp.headers)) {
          respHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => {
          if (timer) clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: respHeaders,
            text: async () => buf.toString('utf8'),
            bytes: async () => buf,
          });
        });
      });
      req.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      if (body) req.write(body);
      req.end();
    });
  }
}

function buildMultipart(
  fields: Record<string, string>,
  files: Record<string, KikiFilePart>,
): { boundary: string; body: Buffer } {
  const boundary = `----KikiBoundary${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, val] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`,
        'utf8',
      ),
    );
  }
  for (const [name, file] of Object.entries(files)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
    );
    parts.push(file.bytes);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(parts) };
}
