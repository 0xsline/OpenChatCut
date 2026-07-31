export { WEB_TOOL_SCHEMAS, WEB_TOOL_NAMES } from './schemas/web-tools';
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';

// Firecrawl tools for the editor agent:
// - web_browser       → POST /api/web-browser       (Firecrawl scrape)
// - web_search        → POST /api/firecrawl/search  (official /v1/search)
// - web_map           → POST /api/firecrawl/map     (official /v1/map)
// - web_crawl         → POST /api/firecrawl/crawl   (official /v1/crawl + poll)
// - web_batch_scrape  → POST /api/firecrawl/batch   (official /v2/batch/scrape + poll)
//
// Docs: https://docs.firecrawl.dev — key never enters the browser.

type Args = Record<string, unknown>;


function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

async function postApi(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      error: `request failed: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'Is the Vite dev server running with FIRECRAWL_API_KEY?',
    };
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function configError(data: Record<string, unknown>): unknown | null {
  if (data.configured === false) {
    return {
      error: data.error ?? 'Firecrawl not configured',
      configured: false,
      hint: 'Set FIRECRAWL_API_KEY in .env.local and restart Vite.',
    };
  }
  if (data.ok === false || (data.error && data.ok !== true && !data.results && !data.pages && !data.links && !data.markdown)) {
    if (data.ok === false || data.error) {
      return {
        ok: false,
        error: data.error ?? 'Firecrawl request failed',
        status: data.status,
        crawlId: data.crawlId,
      };
    }
  }
  return null;
}

export async function execWebTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name === 'web_browser') return execScrape(args, ctx);
  if (name === 'web_search') return execSearch(args);
  if (name === 'web_map') return execMap(args);
  if (name === 'web_crawl') return execCrawl(args);
  if (name === 'web_batch_scrape') return execBatchScrape(args);
  return { error: `unknown tool ${name}` };
}

async function execScrape(args: Args, ctx: AgentContext): Promise<unknown> {
  const url = String(args.url ?? '').trim();
  if (!url || !isHttpUrl(url)) return { error: 'url must be a valid http(s) URI' };

  const body: Record<string, unknown> = {
    url,
    onlyMainContent: args.onlyMainContent !== false,
    fullPage: args.fullPage === true,
  };
  if (Array.isArray(args.formats)) {
    body.formats = args.formats.filter((f): f is string => typeof f === 'string');
  }
  if (typeof args.waitFor === 'number') body.waitFor = args.waitFor;
  if (typeof args.timeout === 'number') body.timeout = args.timeout;
  if (typeof args.country === 'string' && args.country.trim()) body.country = args.country.trim();
  if (typeof args.query === 'string' && args.query.trim()) body.query = args.query.trim();
  if (args.schema != null) body.schema = args.schema;
  if (Array.isArray(args.actions)) body.actions = args.actions.slice(0, 10);
  if (typeof args.execJs === 'string' && args.execJs.trim()) body.execJs = args.execJs;

  const data = await postApi('/api/web-browser', body);
  const err = configError(data);
  if (err) return err;
  if (data.ok === false) {
    return { ok: false, error: data.error ?? 'scrape failed', status: data.status, url };
  }

  const out: Record<string, unknown> = {
    ok: true,
    url: data.url ?? url,
    metadata: data.metadata ?? null,
  };
  for (const key of [
    'markdown', 'html', 'rawHtml', 'links', 'images', 'videos',
    'branding', 'summary', 'extract', 'screenshotPath', 'screenshotUrl',
  ] as const) {
    if (data[key] != null) out[key] = data[key];
  }

  const shotPath = typeof data.screenshotPath === 'string' ? data.screenshotPath : null;
  if (shotPath) {
    const asset: MediaAsset = {
      id: uid('asset'),
      name: `web-screenshot-${new URL(url).hostname}.png`,
      kind: 'image',
      src: shotPath,
      durationInFrames: Math.round(3 * ctx.getState().fps),
      width: 1280,
      height: 720,
    };
    ctx.commands.addAsset(asset);
    out.screenshotAssetId = asset.id;
    out.screenshotSrc = shotPath;
    out.note = 'Screenshot saved to media pool (screenshotAssetId).';
  }
  return out;
}

async function execSearch(args: Args): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required' };
  const body: Record<string, unknown> = {
    query,
    scrapeMarkdown: args.scrapeMarkdown !== false,
  };
  if (typeof args.limit === 'number') body.limit = args.limit;
  if (typeof args.country === 'string') body.country = args.country;
  if (typeof args.lang === 'string') body.lang = args.lang;
  if (typeof args.tbs === 'string') body.tbs = args.tbs;

  const data = await postApi('/api/firecrawl/search', body);
  const err = configError(data);
  if (err) return err;
  if (data.ok === false) return { ok: false, error: data.error, status: data.status };
  return {
    ok: true,
    query: data.query ?? query,
    count: data.count,
    results: data.results,
    creditsUsed: data.creditsUsed,
  };
}

async function execMap(args: Args): Promise<unknown> {
  const url = String(args.url ?? '').trim();
  if (!url || !isHttpUrl(url)) return { error: 'url must be a valid http(s) URI' };
  const body: Record<string, unknown> = {
    url,
    includeSubdomains: args.includeSubdomains !== false,
    ignoreQueryParameters: args.ignoreQueryParameters !== false,
  };
  if (typeof args.search === 'string' && args.search.trim()) body.search = args.search.trim();
  if (typeof args.limit === 'number') body.limit = args.limit;
  if (typeof args.sitemap === 'string') body.sitemap = args.sitemap;

  const data = await postApi('/api/firecrawl/map', body);
  const err = configError(data);
  if (err) return err;
  if (data.ok === false) return { ok: false, error: data.error, status: data.status };
  return {
    ok: true,
    url: data.url ?? url,
    count: data.count,
    links: data.links,
  };
}

async function execCrawl(args: Args): Promise<unknown> {
  const url = String(args.url ?? '').trim();
  if (!url || !isHttpUrl(url)) return { error: 'url must be a valid http(s) URI' };
  const body: Record<string, unknown> = {
    url,
    allowSubdomains: args.allowSubdomains === true,
    crawlEntireDomain: args.crawlEntireDomain === true,
  };
  if (typeof args.limit === 'number') body.limit = args.limit;
  if (typeof args.maxDiscoveryDepth === 'number') body.maxDiscoveryDepth = args.maxDiscoveryDepth;
  else if (typeof args.maxDepth === 'number') body.maxDepth = args.maxDepth;
  if (Array.isArray(args.includePaths)) body.includePaths = args.includePaths;
  if (Array.isArray(args.excludePaths)) body.excludePaths = args.excludePaths;
  if (typeof args.maxWaitMs === 'number') body.maxWaitMs = args.maxWaitMs;

  const data = await postApi('/api/firecrawl/crawl', body);
  const err = configError(data);
  if (err) return err;
  if (data.ok === false) {
    return {
      ok: false,
      error: data.error,
      crawlId: data.crawlId,
      status: data.status,
      partialCount: data.partialCount,
    };
  }
  return {
    ok: true,
    crawlId: data.crawlId,
    status: data.status,
    url: data.url ?? url,
    count: data.count,
    pages: data.pages,
  };
}

async function execBatchScrape(args: Args): Promise<unknown> {
  const raw = Array.isArray(args.urls) ? args.urls : [];
  const urls = raw
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter((u) => isHttpUrl(u))
    .slice(0, 15);
  if (!urls.length) return { error: 'urls must be a non-empty array of http(s) URIs (max 15)' };

  const body: Record<string, unknown> = {
    urls,
    onlyMainContent: args.onlyMainContent !== false,
  };
  if (Array.isArray(args.formats)) {
    body.formats = args.formats.filter((f): f is string => typeof f === 'string');
  }
  if (typeof args.maxWaitMs === 'number') body.maxWaitMs = args.maxWaitMs;

  const data = await postApi('/api/firecrawl/batch', body);
  const err = configError(data);
  if (err) return err;
  if (data.ok === false) {
    return {
      ok: false,
      error: data.error,
      batchId: data.batchId,
      status: data.status,
      partialCount: data.partialCount,
      completed: data.completed,
      total: data.total,
    };
  }
  return {
    ok: true,
    batchId: data.batchId,
    status: data.status,
    count: data.count,
    completed: data.completed,
    total: data.total,
    creditsUsed: data.creditsUsed,
    invalidURLs: data.invalidURLs,
    pages: data.pages,
  };
}
