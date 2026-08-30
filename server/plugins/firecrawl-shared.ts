// Firecrawl transport and request plumbing: the proxy-aware fetch, JSON body
// read/write, URL validation, the format mapping between our API shape and
// Firecrawl's, and screenshot persistence. Split out of firecrawl.ts, which
// stays the plugin entry point and re-exports what callers already imported.

import { proxyDispatcher } from '../outbound-proxy.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { uploadDir } from '../media-dir.ts';
import { safePublicFetch } from '../safe-public-fetch.ts';

// Proxy-aware fetch: attaches the configured outbound proxy (keystore
// PROXY_URL or HTTPS_PROXY/HTTP_PROXY env) via undici dispatcher.
export type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
export const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);


/**
 * Firecrawl proxy (official API + web_browser scrape).
 * Keys stay server-side only.
 *
 * POST /api/web-browser            → POST /v1/scrape  (backs the web_browser tool)
 * POST /api/firecrawl/search       → POST /v1/search
 * POST /api/firecrawl/map          → POST /v1/map
 * POST /api/firecrawl/crawl        → POST /v1/crawl + poll
 * POST /api/firecrawl/batch        → POST /v2/batch/scrape + poll GET /v2/batch/scrape/:id
 *
 * Docs: https://docs.firecrawl.dev
 */

export const FC_V1 = 'https://api.firecrawl.dev/v1';
export const FC_V2 = 'https://api.firecrawl.dev/v2';
export const MAX_BODY = 2 * 1024 * 1024;

export interface FirecrawlPluginOptions {
  apiKey: string;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function notConfigured(res: ServerResponse, apiKey: string): boolean {
  if (apiKey) return false;
  sendJson(res, 200, {
    configured: false,
    error: 'FIRECRAWL_API_KEY not set (add to .env.local or export in shell)',
  });
  return true;
}

export async function fcFetch(
  apiKey: string,
  path: string,
  init?: RequestInit,
  base: string = FC_V1,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const r = await fetchWithProxy(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, json };
}

export function fcError(json: Record<string, unknown>, status: number): string {
  return String(json.error || json.message || `Firecrawl HTTP ${status}`);
}

export function truncate(s: string, max = 80_000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars]`;
}

export type SourceFormat =
  | 'markdown' | 'html' | 'rawHtml' | 'images' | 'links'
  | 'branding' | 'summary' | 'screenshot' | 'videos';

export function mapFormats(
  formats: SourceFormat[],
  fullPage: boolean,
  query?: string,
  schema?: unknown,
): unknown[] {
  const out: unknown[] = [];
  const want = new Set(formats.length ? formats : (['markdown'] as SourceFormat[]));

  if (want.has('markdown')) out.push('markdown');
  if (want.has('html')) out.push('html');
  if (want.has('rawHtml')) out.push('rawHtml');
  if (want.has('links') || want.has('images') || want.has('videos')) out.push('links');
  // String formats work on both v1 scrape and v2 batch; objects also work on v2.
  if (want.has('screenshot')) out.push(fullPage ? 'screenshot@fullPage' : 'screenshot');
  // Official native formats → data.branding / data.summary (not json extract)
  if (want.has('branding')) out.push('branding');
  if (want.has('summary')) out.push('summary');

  // Structured extract via query/schema (separate from native summary/branding)
  if (query || schema) {
    const extract: Record<string, unknown> = { type: 'json' };
    if (schema && typeof schema === 'object') extract.schema = schema;
    if (query) extract.prompt = query;
    if (extract.prompt || extract.schema) out.push(extract);
  }

  if (!out.length) out.push('markdown');
  return out;
}

/** Firecrawl executes executeJavascript scripts in a scope where a top-level
 *  `return` is a SyntaxError ("Illegal return statement"). Models naturally
 *  write `return expr` (or `return document.querySelector(...)`); wrapping
 *  such scripts in an IIFE keeps the model's style valid. Scripts without a
 *  top-level return pass through untouched. */
export function wrapExecJs(script: string): string {
  return /(^|\n)\s*return\b/m.test(script) ? `(() => {\n${script}\n})()` : script;
}

export function buildActions(
  actions: unknown[] | undefined,
  execJs: string | undefined,
): unknown[] | undefined {
  const list: unknown[] = (Array.isArray(actions) ? actions.slice(0, 10) : []).map((action) => {
    if (
      action && typeof action === 'object'
      && (action as { type?: unknown }).type === 'executeJavascript'
      && typeof (action as { script?: unknown }).script === 'string'
    ) {
      return {
        ...(action as Record<string, unknown>),
        script: wrapExecJs((action as { script: string }).script),
      };
    }
    return action;
  });
  if (execJs?.trim()) {
    list.push({ type: 'executeJavascript', script: wrapExecJs(execJs.slice(0, 10_000)) });
  }
  return list.length ? list : undefined;
}

export async function saveScreenshot(data: unknown): Promise<string | null> {
  try {
    if (!data || typeof data !== 'string') return null;
    let buf: Buffer;
    if (data.startsWith('data:image')) {
      const b64 = data.split(',')[1] ?? '';
      if (!b64) return null;
      buf = Buffer.from(b64, 'base64');
    } else if (data.startsWith('http://') || data.startsWith('https://')) {
      const r = await safePublicFetch(data, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) return null;
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      if (data.length < 64) return null;
      buf = Buffer.from(data, 'base64');
    }
    if (buf.length < 256) return null;
    const directory = uploadDir();
    await mkdir(directory, { recursive: true });
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const fname = `${randomUUID()}${isJpeg ? '.jpg' : '.png'}`;
    await writeFile(join(directory, fname), buf);
    return `/media/uploads/${fname}`;
  } catch {
    return null;
  }
}

export function filterUrls(links: string[] | undefined, kind: 'images' | 'videos'): string[] {
  if (!links?.length) return [];
  const re = kind === 'images'
    ? /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|$)/i
    : /\.(mp4|webm|mov|m4v|avi)(\?|$)/i;
  return links.filter((u) => re.test(u)).slice(0, 50);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
