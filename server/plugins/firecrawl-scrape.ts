// The three single-shot Firecrawl endpoints: scrape one page, search, and map
// a site's URLs. Each shapes its own request and slims the response; the long
// polling jobs live in firecrawl-crawl.ts, the transport in firecrawl-shared.ts.

import type { ServerResponse } from 'node:http';
import type { SourceFormat } from './firecrawl-shared.ts';
import {
  buildActions, fcError, fcFetch, filterUrls, isHttpUrl, mapFormats, saveScreenshot, sendJson, truncate,
} from './firecrawl-shared.ts';

export async function handleScrape(
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

export async function handleSearch(
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

export async function handleMap(
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
