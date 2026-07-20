import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

const UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');
const FC_V1 = 'https://api.firecrawl.dev/v1';
const FC_V2 = 'https://api.firecrawl.dev/v2';
const MAX_BODY = 2 * 1024 * 1024;

export interface FirecrawlPluginOptions {
  apiKey: string;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function notConfigured(res: ServerResponse, apiKey: string): boolean {
  if (apiKey) return false;
  sendJson(res, 200, {
    configured: false,
    error: 'FIRECRAWL_API_KEY not set (add to .env.local or export in shell)',
  });
  return true;
}

async function fcFetch(
  apiKey: string,
  path: string,
  init?: RequestInit,
  base: string = FC_V1,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
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

function fcError(json: Record<string, unknown>, status: number): string {
  return String(json.error || json.message || `Firecrawl HTTP ${status}`);
}

function truncate(s: string, max = 80_000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars]`;
}

type SourceFormat =
  | 'markdown' | 'html' | 'rawHtml' | 'images' | 'links'
  | 'branding' | 'summary' | 'screenshot' | 'videos';

function mapFormats(
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

function buildActions(
  actions: unknown[] | undefined,
  execJs: string | undefined,
): unknown[] | undefined {
  const list: unknown[] = Array.isArray(actions) ? actions.slice(0, 10) : [];
  if (execJs?.trim()) {
    list.push({ type: 'executeJavascript', script: execJs.slice(0, 10_000) });
  }
  return list.length ? list : undefined;
}

async function saveScreenshot(data: unknown): Promise<string | null> {
  try {
    if (!data || typeof data !== 'string') return null;
    let buf: Buffer;
    if (data.startsWith('data:image')) {
      const b64 = data.split(',')[1] ?? '';
      if (!b64) return null;
      buf = Buffer.from(b64, 'base64');
    } else if (data.startsWith('http://') || data.startsWith('https://')) {
      const r = await fetch(data, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) return null;
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      if (data.length < 64) return null;
      buf = Buffer.from(data, 'base64');
    }
    if (buf.length < 256) return null;
    await mkdir(UPLOAD_DIR, { recursive: true });
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const fname = `${randomUUID()}${isJpeg ? '.jpg' : '.png'}`;
    await writeFile(join(UPLOAD_DIR, fname), buf);
    return `/media/uploads/${fname}`;
  } catch {
    return null;
  }
}

function filterUrls(links: string[] | undefined, kind: 'images' | 'videos'): string[] {
  if (!links?.length) return [];
  const re = kind === 'images'
    ? /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|$)/i
    : /\.(mp4|webm|mov|m4v|avi)(\?|$)/i;
  return links.filter((u) => re.test(u)).slice(0, 50);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleScrape(
  apiKey: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  log: (m: string) => void,
): Promise<void> {
  const url = String(body.url ?? '').trim();
  if (!url || !isHttpUrl(url)) {
    sendJson(res, 400, { error: 'url must be a valid http(s) URI' });
    return;
  }

  const formatsIn = Array.isArray(body.formats)
    ? (body.formats as string[]).filter((f): f is SourceFormat => typeof f === 'string') as SourceFormat[]
    : (['markdown'] as SourceFormat[]);
  const fullPage = body.fullPage === true;
  const onlyMainContent = body.onlyMainContent !== false;
  const waitFor = typeof body.waitFor === 'number'
    ? Math.max(0, Math.min(10_000, Math.round(body.waitFor)))
    : undefined;
  const timeout = typeof body.timeout === 'number'
    ? Math.max(1, Math.min(60_000, Math.round(body.timeout)))
    : 45_000;
  const country = typeof body.country === 'string' ? body.country.trim() : '';
  const query = typeof body.query === 'string' ? body.query : undefined;
  const schema = body.schema;
  const execJs = typeof body.execJs === 'string' ? body.execJs : undefined;
  const actions = buildActions(Array.isArray(body.actions) ? body.actions : undefined, execJs);

  const payload: Record<string, unknown> = {
    url,
    formats: mapFormats(formatsIn, fullPage, query, schema),
    onlyMainContent,
    timeout,
  };
  if (waitFor != null) payload.waitFor = waitFor;
  if (actions) payload.actions = actions;
  if (country) payload.location = { country };

  const { ok, status, json } = await fcFetch(apiKey, '/scrape', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!ok) {
    sendJson(res, 200, { configured: true, ok: false, error: fcError(json, status), status });
    return;
  }

  const data = (json.data ?? json) as Record<string, unknown>;
  const links = Array.isArray(data.links) ? (data.links as string[]) : undefined;
  const want = new Set(formatsIn.length ? formatsIn : ['markdown']);
  const out: Record<string, unknown> = {
    configured: true,
    ok: true,
    url,
    metadata: data.metadata ?? null,
  };

  if (want.has('markdown') && typeof data.markdown === 'string') out.markdown = truncate(data.markdown);
  if (want.has('html') && typeof data.html === 'string') out.html = truncate(data.html);
  if (want.has('rawHtml') && typeof data.rawHtml === 'string') out.rawHtml = truncate(data.rawHtml);
  if (want.has('links') && links) out.links = links.slice(0, 100);
  if (want.has('images')) {
    const fromMeta = (data.metadata as { ogImage?: string } | undefined)?.ogImage;
    const imgs = filterUrls(links, 'images');
    if (fromMeta && isHttpUrl(fromMeta)) imgs.unshift(fromMeta);
    out.images = [...new Set(imgs)].slice(0, 50);
  }
  if (want.has('videos')) out.videos = filterUrls(links, 'videos');

  // Native branding / summary fields (official formats)
  if (want.has('branding') && data.branding != null) out.branding = data.branding;
  if (want.has('summary') && data.summary != null) {
    out.summary = typeof data.summary === 'string' ? data.summary : data.summary;
  }

  const extracted = data.json ?? data.extract ?? null;
  if (extracted != null) {
    // Fallback if native fields missing (older API path)
    if (want.has('branding') && out.branding == null) out.branding = extracted;
    if (want.has('summary') && out.summary == null) {
      out.summary = typeof extracted === 'object' && extracted && 'summary' in (extracted as object)
        ? (extracted as { summary: unknown }).summary
        : extracted;
    }
    if (query || schema) out.extract = extracted;
  }

  if (want.has('screenshot')) {
    const shot = data.screenshot ?? data.screenshotUrl;
    try {
      const path = await saveScreenshot(shot);
      if (path) {
        out.screenshotPath = path;
        out.screenshot = true;
      } else if (typeof shot === 'string' && isHttpUrl(shot)) {
        out.screenshotUrl = shot;
      } else if (shot) {
        out.screenshotNote = 'screenshot payload received but could not be saved';
      }
    } catch (e) {
      out.screenshotNote = e instanceof Error ? e.message : String(e);
      log(`[web-browser] screenshot save: ${out.screenshotNote}`);
    }
  }

  sendJson(res, 200, out);
}

async function handleSearch(
  apiKey: string,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const query = String(body.query ?? '').trim();
  if (!query) {
    sendJson(res, 400, { error: 'query is required' });
    return;
  }
  const limit = typeof body.limit === 'number'
    ? Math.max(1, Math.min(20, Math.round(body.limit)))
    : 5;
  const lang = typeof body.lang === 'string' ? body.lang : undefined;
  const country = typeof body.country === 'string' ? body.country.trim() : undefined;
  const tbs = typeof body.tbs === 'string' ? body.tbs : undefined;
  const scrapeMarkdown = body.scrapeMarkdown !== false;

  const payload: Record<string, unknown> = {
    query,
    limit,
  };
  if (lang) payload.lang = lang;
  if (country) payload.country = country;
  if (tbs) payload.tbs = tbs;
  // Official: scrapeOptions.formats so each result can include markdown
  if (scrapeMarkdown) {
    payload.scrapeOptions = {
      formats: ['markdown'],
      onlyMainContent: true,
    };
  }

  const { ok, status, json } = await fcFetch(apiKey, '/search', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!ok) {
    sendJson(res, 200, { configured: true, ok: false, error: fcError(json, status), status });
    return;
  }

  // v1 returns data as array; v2 may nest web/images/news
  const raw = json.data;
  let results: unknown[] = [];
  if (Array.isArray(raw)) {
    results = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.web)) results = o.web as unknown[];
    else if (Array.isArray(o.data)) results = o.data as unknown[];
  }

  const slim = results.slice(0, limit).map((item) => {
    const r = item as Record<string, unknown>;
    const md = typeof r.markdown === 'string' ? truncate(r.markdown, 12_000) : undefined;
    return {
      url: r.url ?? r.link,
      title: r.title,
      description: r.description ?? r.snippet,
      markdown: md,
      category: r.category,
    };
  });

  sendJson(res, 200, {
    configured: true,
    ok: true,
    query,
    count: slim.length,
    results: slim,
    creditsUsed: json.creditsUsed ?? null,
  });
}

async function handleMap(
  apiKey: string,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const url = String(body.url ?? '').trim();
  if (!url || !isHttpUrl(url)) {
    sendJson(res, 400, { error: 'url must be a valid http(s) URI' });
    return;
  }
  const limit = typeof body.limit === 'number'
    ? Math.max(1, Math.min(500, Math.round(body.limit)))
    : 100;
  const search = typeof body.search === 'string' ? body.search.trim() : undefined;
  const includeSubdomains = body.includeSubdomains !== false;
  const ignoreQueryParameters = body.ignoreQueryParameters !== false;
  const sitemap = typeof body.sitemap === 'string' ? body.sitemap : undefined;

  const payload: Record<string, unknown> = {
    url,
    limit,
    includeSubdomains,
    ignoreQueryParameters,
  };
  if (search) payload.search = search;
  // v1 uses ignoreSitemap boolean; v2 uses sitemap: skip|include|only
  if (sitemap === 'skip') payload.ignoreSitemap = true;
  else if (sitemap === 'only' || sitemap === 'include') payload.sitemap = sitemap;

  const { ok, status, json } = await fcFetch(apiKey, '/map', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!ok) {
    sendJson(res, 200, { configured: true, ok: false, error: fcError(json, status), status });
    return;
  }

  // Response shapes: links: string[] | {url,title,description}[]
  const linksRaw = json.links ?? (json.data as { links?: unknown } | undefined)?.links;
  let links: { url: string; title?: string; description?: string }[] = [];
  if (Array.isArray(linksRaw)) {
    links = linksRaw.map((x) => {
      if (typeof x === 'string') return { url: x };
      const o = x as Record<string, unknown>;
      return {
        url: String(o.url ?? o.link ?? ''),
        title: typeof o.title === 'string' ? o.title : undefined,
        description: typeof o.description === 'string' ? o.description : undefined,
      };
    }).filter((x) => x.url);
  }

  sendJson(res, 200, {
    configured: true,
    ok: true,
    url,
    count: links.length,
    links: links.slice(0, limit),
  });
}

async function handleCrawl(
  apiKey: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  log: (m: string) => void,
): Promise<void> {
  const url = String(body.url ?? '').trim();
  if (!url || !isHttpUrl(url)) {
    sendJson(res, 400, { error: 'url must be a valid http(s) URI' });
    return;
  }

  const limit = typeof body.limit === 'number'
    ? Math.max(1, Math.min(50, Math.round(body.limit)))
    : 10;
  const maxDiscoveryDepth = typeof body.maxDiscoveryDepth === 'number'
    ? Math.max(0, Math.min(5, Math.round(body.maxDiscoveryDepth)))
    : typeof body.maxDepth === 'number'
      ? Math.max(0, Math.min(5, Math.round(body.maxDepth)))
      : undefined;
  const includePaths = Array.isArray(body.includePaths)
    ? (body.includePaths as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
    : undefined;
  const excludePaths = Array.isArray(body.excludePaths)
    ? (body.excludePaths as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
    : undefined;
  const allowSubdomains = body.allowSubdomains === true;
  const crawlEntireDomain = body.crawlEntireDomain === true;
  const pollMs = typeof body.pollMs === 'number'
    ? Math.max(500, Math.min(5_000, Math.round(body.pollMs)))
    : 2_000;
  const maxWaitMs = typeof body.maxWaitMs === 'number'
    ? Math.max(5_000, Math.min(180_000, Math.round(body.maxWaitMs)))
    : 90_000;

  const payload: Record<string, unknown> = {
    url,
    limit,
    scrapeOptions: {
      formats: ['markdown'],
      onlyMainContent: true,
    },
  };
  if (maxDiscoveryDepth != null) {
    // v1 used maxDepth; v2 maxDiscoveryDepth — send both for compatibility
    payload.maxDepth = maxDiscoveryDepth;
    payload.maxDiscoveryDepth = maxDiscoveryDepth;
  }
  if (includePaths?.length) payload.includePaths = includePaths;
  if (excludePaths?.length) payload.excludePaths = excludePaths;
  if (allowSubdomains) {
    payload.allowSubdomains = true;
    payload.allowSubdomainsV2 = true;
  }
  if (crawlEntireDomain) payload.crawlEntireDomain = true;

  const start = await fcFetch(apiKey, '/crawl', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!start.ok) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: fcError(start.json, start.status),
      status: start.status,
    });
    return;
  }

  const jobId = String(start.json.id ?? (start.json.data as { id?: string } | undefined)?.id ?? '');
  if (!jobId) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: 'Firecrawl crawl did not return a job id',
      raw: start.json,
    });
    return;
  }

  const deadline = Date.now() + maxWaitMs;
  let lastStatus = 'scraping';
  let pages: Record<string, unknown>[] = [];

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = await fcFetch(apiKey, `/crawl/${encodeURIComponent(jobId)}`, { method: 'GET' });
    if (!st.ok) {
      sendJson(res, 200, {
        configured: true,
        ok: false,
        error: fcError(st.json, st.status),
        crawlId: jobId,
        status: st.status,
      });
      return;
    }
    const d = st.json as Record<string, unknown>;
    lastStatus = String(d.status ?? d.state ?? 'unknown');
    const dataArr = Array.isArray(d.data) ? d.data as Record<string, unknown>[] : [];
    if (dataArr.length) pages = dataArr;

    if (lastStatus === 'completed' || lastStatus === 'failed' || lastStatus === 'cancelled') {
      break;
    }
    log(`[crawl] id=${jobId} status=${lastStatus} pages=${pages.length}`);
  }

  if (lastStatus !== 'completed' && !pages.length) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: `crawl not completed (status=${lastStatus}) within ${maxWaitMs}ms`,
      crawlId: jobId,
      status: lastStatus,
      partialCount: pages.length,
    });
    return;
  }

  const slim = pages.slice(0, limit).map((p) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const pageUrl = String(meta.sourceURL ?? meta.url ?? p.url ?? '');
    const md = typeof p.markdown === 'string' ? truncate(p.markdown, 8_000) : undefined;
    return {
      url: pageUrl,
      title: meta.title,
      markdown: md,
      statusCode: meta.statusCode,
    };
  });

  sendJson(res, 200, {
    configured: true,
    ok: lastStatus === 'completed' || slim.length > 0,
    crawlId: jobId,
    status: lastStatus,
    url,
    count: slim.length,
    pages: slim,
  });
}

/** Batch scrape many known URLs (official v2 /batch/scrape + status poll). */
async function handleBatchScrape(
  apiKey: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  log: (m: string) => void,
): Promise<void> {
  const rawUrls = Array.isArray(body.urls) ? body.urls : [];
  const urls = rawUrls
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter((u) => isHttpUrl(u))
    .slice(0, 15);
  if (!urls.length) {
    sendJson(res, 400, { error: 'urls must be a non-empty array of http(s) URIs (max 15)' });
    return;
  }

  const formatsIn = Array.isArray(body.formats)
    ? (body.formats as string[]).filter((f): f is SourceFormat => typeof f === 'string') as SourceFormat[]
    : (['markdown'] as SourceFormat[]);
  const onlyMainContent = body.onlyMainContent !== false;
  const pollMs = typeof body.pollMs === 'number'
    ? Math.max(500, Math.min(5_000, Math.round(body.pollMs)))
    : 2_000;
  const maxWaitMs = typeof body.maxWaitMs === 'number'
    ? Math.max(5_000, Math.min(180_000, Math.round(body.maxWaitMs)))
    : 90_000;

  const payload: Record<string, unknown> = {
    urls,
    formats: mapFormats(formatsIn, false),
    onlyMainContent,
    ignoreInvalidURLs: true,
  };

  // Official batch is v2
  const start = await fcFetch(apiKey, '/batch/scrape', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, FC_V2);
  if (!start.ok) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: fcError(start.json, start.status),
      status: start.status,
    });
    return;
  }

  const jobId = String(start.json.id ?? (start.json.data as { id?: string } | undefined)?.id ?? '');
  if (!jobId) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: 'Firecrawl batch scrape did not return a job id',
      raw: start.json,
    });
    return;
  }

  const invalidURLs = Array.isArray(start.json.invalidURLs)
    ? start.json.invalidURLs
    : undefined;

  const deadline = Date.now() + maxWaitMs;
  let lastStatus = 'scraping';
  let pages: Record<string, unknown>[] = [];
  let creditsUsed: unknown = null;
  let total = 0;
  let completed = 0;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = await fcFetch(
      apiKey,
      `/batch/scrape/${encodeURIComponent(jobId)}`,
      { method: 'GET' },
      FC_V2,
    );
    if (!st.ok) {
      sendJson(res, 200, {
        configured: true,
        ok: false,
        error: fcError(st.json, st.status),
        batchId: jobId,
        status: st.status,
      });
      return;
    }
    const d = st.json as Record<string, unknown>;
    lastStatus = String(d.status ?? 'unknown');
    total = typeof d.total === 'number' ? d.total : total;
    completed = typeof d.completed === 'number' ? d.completed : completed;
    creditsUsed = d.creditsUsed ?? creditsUsed;
    const dataArr = Array.isArray(d.data) ? d.data as Record<string, unknown>[] : [];
    if (dataArr.length) pages = dataArr;

    if (lastStatus === 'completed' || lastStatus === 'failed' || lastStatus === 'cancelled') {
      break;
    }
    log(`[batch] id=${jobId} status=${lastStatus} completed=${completed}/${total}`);
  }

  if (lastStatus !== 'completed' && !pages.length) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: `batch not completed (status=${lastStatus}) within ${maxWaitMs}ms`,
      batchId: jobId,
      status: lastStatus,
      partialCount: pages.length,
      completed,
      total,
    });
    return;
  }

  const want = new Set(formatsIn.length ? formatsIn : ['markdown']);
  const slim = pages.map((p) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const pageUrl = String(meta.sourceURL ?? meta.url ?? p.url ?? '');
    const row: Record<string, unknown> = {
      url: pageUrl,
      title: meta.title,
      statusCode: meta.statusCode,
    };
    if (want.has('markdown') && typeof p.markdown === 'string') {
      row.markdown = truncate(p.markdown, 8_000);
    }
    if (want.has('summary') && p.summary != null) row.summary = p.summary;
    if (want.has('branding') && p.branding != null) row.branding = p.branding;
    if (want.has('links') && Array.isArray(p.links)) row.links = (p.links as string[]).slice(0, 40);
    if (meta.error) row.error = meta.error;
    return row;
  });

  sendJson(res, 200, {
    configured: true,
    ok: lastStatus === 'completed' || slim.length > 0,
    batchId: jobId,
    status: lastStatus,
    count: slim.length,
    completed,
    total,
    creditsUsed,
    invalidURLs,
    pages: slim,
  });
}

export function firecrawlPlugin(options: FirecrawlPluginOptions): Plugin {
  return {
    name: 'openchatcut-firecrawl',
    configureServer(server) {
      const log = (m: string) => server.config.logger.info(m);
      const key = options.apiKey;

      server.middlewares.use('/api/web-browser', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleScrape(key, body, res, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[web-browser] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/search', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleSearch(key, body, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/search] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/map', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleMap(key, body, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/map] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/crawl', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleCrawl(key, body, res, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/crawl] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/batch', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleBatchScrape(key, body, res, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/batch] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });
    },
  };
}
