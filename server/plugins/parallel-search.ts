// Anonymous Search MCP adapter. Provider selection stays in the web middleware;
// an explicit provider failure is returned to the caller without a fallback.
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fetchWithProxy, isHttpUrl, truncate } from './firecrawl-shared.ts';

const ENDPOINT = 'https://search.parallel.ai/mcp';
const USER_AGENT = 'OpenChatCut (+https://github.com/0xsline/OpenChatCut)';

type Body = Record<string, unknown>;

export async function parallelWebRequest(
  operation: 'search' | 'fetch',
  body: Body,
  signal: AbortSignal,
): Promise<Body> {
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (operation === 'search' && !query) throw new Error('query is required');
  if (operation === 'fetch' && !isHttpUrl(url)) throw new Error('url must be a valid http(s) URI');
  // Parallel returns relevant excerpts. Firecrawl keeps locale/time filters,
  // screenshots, actions, structured extraction and complete-page formats.
  const unsupported = operation === 'search'
    ? ['country', 'lang', 'tbs']
    : ['country', 'waitFor', 'actions', 'execJs', 'schema', 'fullPage'];
  if (unsupported.some((key) => body[key] != null && body[key] !== false && body[key] !== '')
      || (operation === 'fetch' && (body.onlyMainContent === false
        || (Array.isArray(body.formats) && body.formats.some((f) => f !== 'markdown'))))) {
    throw new Error('These options require provider="firecrawl" and FIRECRAWL_API_KEY. Parallel supports search and page excerpts.');
  }
  const args: Body = operation === 'search'
    ? { objective: query, search_queries: [query] }
    : { urls: [url], ...(query ? { objective: query.slice(0, 200) } : {}) };
  if (typeof body.sessionId === 'string' && /^[a-f0-9-]{36}$/.test(body.sessionId)) {
    args.session_id = body.sessionId;
  }
  const client = new Client({ name: 'openchatcut', version: '0.2.17' });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('User-Agent', USER_AGENT);
      return fetchWithProxy(input, { ...init, headers,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
    },
  });
  try {
    await client.connect(transport, { signal, timeout: 60_000 });
    await client.listTools({}, { signal, timeout: 60_000 });
    const result = CallToolResultSchema.parse(await client.callTool({
      name: operation === 'search' ? 'web_search' : 'web_fetch', arguments: args,
    }, CallToolResultSchema, { signal, timeout: 60_000 }));
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text).join('\n');
    if (result.isError) throw new Error(text || 'Parallel Search MCP request failed');
    const data = (result.structuredContent ?? JSON.parse(text)) as Body;
    if (!Array.isArray(data.results)) throw new Error('Invalid Parallel Search MCP results');
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(20, Math.round(body.limit))) : 5;
    const results = data.results.slice(0, operation === 'search' ? limit : 1).map((value) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid Parallel Search MCP result');
      const item = value as Body;
      if (typeof item.url !== 'string' || !isHttpUrl(item.url) || !Array.isArray(item.excerpts)
          || item.excerpts.some((excerpt) => typeof excerpt !== 'string')) {
        throw new Error('Invalid Parallel Search MCP result');
      }
      const excerpts = (item.excerpts as string[]).map((excerpt) => truncate(excerpt, 12_000));
      return { url: item.url, title: item.title, description: excerpts.join('\n\n'), excerpts };
    });
    if (operation === 'search') {
      return { configured: true, ok: true, provider: 'parallel', query, count: results.length,
        results, warnings: data.warnings };
    }
    if (!results.length) throw new Error(JSON.stringify(data.errors ?? 'Parallel could not read the page'));
    return { configured: true, ok: true, provider: 'parallel', url: results[0]!.url,
      metadata: { title: results[0]!.title }, markdown: results[0]!.description,
      excerpts: results[0]!.excerpts, warnings: data.warnings };
  } finally {
    await client.close();
  }
}
