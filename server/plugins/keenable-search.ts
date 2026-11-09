// Keyless Keenable search/fetch adapter. Provider selection stays in the web
// middleware; an explicit provider failure is returned to the caller without a
// fallback. KEENABLE_API_KEY is optional and only lifts the anonymous rate limit.
import { fetchWithProxy, isHttpUrl, truncate } from './firecrawl-shared.ts';

const BASE = 'https://api.keenable.ai';
const APP_TITLE = 'OpenChatCut';
const USER_AGENT = 'OpenChatCut (+https://github.com/0xsline/OpenChatCut)';

type Body = Record<string, unknown>;

// Keenable returns ranked results with markdown snippets, or a page as markdown.
// Firecrawl keeps locale/time filters, screenshots, actions, structured
// extraction and complete-page formats.
const UNSUPPORTED = (operation: 'search' | 'fetch'): string[] => operation === 'search'
  ? ['country', 'lang', 'tbs']
  : ['country', 'waitFor', 'actions', 'execJs', 'schema', 'fullPage'];

export async function keenableWebRequest(
  operation: 'search' | 'fetch',
  body: Body,
  signal: AbortSignal,
  apiKey?: string,
): Promise<Body> {
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (operation === 'search' && !query) throw new Error('query is required');
  if (operation === 'fetch' && !isHttpUrl(url)) throw new Error('url must be a valid http(s) URI');
  if (UNSUPPORTED(operation).some((key) => body[key] != null && body[key] !== false && body[key] !== '')
      || (operation === 'fetch' && (body.onlyMainContent === false
        || (Array.isArray(body.formats) && body.formats.some((f) => f !== 'markdown'))))) {
    throw new Error('These options require provider="firecrawl" and FIRECRAWL_API_KEY. Keenable supports search and markdown page reads.');
  }

  const headers = new Headers({ 'X-Keenable-Title': APP_TITLE, 'User-Agent': USER_AGENT });
  if (apiKey) headers.set('X-API-Key', apiKey);
  if (typeof body.sessionId === 'string' && /^[a-f0-9-]{36}$/.test(body.sessionId)) {
    headers.set('X-Keenable-Session-Id', body.sessionId);
  }

  let response: Response;
  if (operation === 'search') {
    const payload: Body = { query };
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(50, Math.round(body.limit))) : 5;
    if (limit !== 10) payload.max_results = limit; // 10 is Keenable's default
    response = await fetchWithProxy(`${BASE}/v1/search${apiKey ? '' : '/public'}`, {
      method: 'POST',
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } else {
    response = await fetchWithProxy(`${BASE}/v1/fetch${apiKey ? '' : '/public'}?${new URLSearchParams({ url })}`, {
      headers, signal,
    });
  }
  const data = (await response.json().catch(() => ({}))) as Body;
  if (!response.ok) {
    throw new Error(String(data.message || data.error || `Keenable HTTP ${response.status}`));
  }

  if (operation === 'search') {
    if (!Array.isArray(data.results)) throw new Error('Invalid Keenable search results');
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(50, Math.round(body.limit))) : 5;
    const results = data.results.slice(0, limit).map((value) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid Keenable search result');
      const item = value as Body;
      if (typeof item.url !== 'string' || !isHttpUrl(item.url)) {
        throw new Error('Invalid Keenable search result');
      }
      const snippet = typeof item.snippet === 'string' ? truncate(item.snippet, 12_000) : '';
      return {
        url: item.url,
        title: item.title,
        description: snippet,
        snippet,
        publishedAt: item.published_at,
        acquiredAt: item.acquired_at,
      };
    });
    return { configured: true, ok: true, provider: 'keenable', query, count: results.length,
      results, warnings: data.warning };
  }
  const content = typeof data.content === 'string' ? truncate(data.content, 80_000) : '';
  if (!content) throw new Error('Keenable returned no page content');
  return {
    configured: true, ok: true, provider: 'keenable',
    url: typeof data.url === 'string' ? data.url : url,
    metadata: { title: data.title, author: data.author, publishedAt: data.published_at },
    markdown: content, warnings: data.warning,
  };
}