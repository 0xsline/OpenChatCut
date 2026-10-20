import assert from 'node:assert/strict';
import { WEB_TOOL_NAMES, WEB_TOOL_SCHEMAS } from './web-tools';

const names = WEB_TOOL_SCHEMAS.map((t) => t.name);
assert.deepEqual(
  names.sort(),
  ['web_batch_scrape', 'web_browser', 'web_crawl', 'web_map', 'web_search'].sort(),
);
for (const n of names) assert.ok(WEB_TOOL_NAMES.has(n));

const byName = Object.fromEntries(WEB_TOOL_SCHEMAS.map((t) => [t.name, t]));
assert.deepEqual((byName.web_browser!.input_schema as { required?: string[] }).required, ['url']);
assert.deepEqual((byName.web_search!.input_schema as { required?: string[] }).required, ['query']);
assert.deepEqual((byName.web_map!.input_schema as { required?: string[] }).required, ['url']);
assert.deepEqual((byName.web_crawl!.input_schema as { required?: string[] }).required, ['url']);
assert.deepEqual((byName.web_batch_scrape!.input_schema as { required?: string[] }).required, ['urls']);

console.log('web-tools.check: OK', names.join(', '));

// Exercise the real validated dispatcher, local HTTP route and MCP SDK. The
// model itself is scripted here; every owned request and consumed result is real.
const { createServer } = await import('node:http');
const { firecrawlPlugin } = await import('../../../server/plugins/firecrawl');
const { executeOpenChatCutTool } = await import('../codex/runtime');
const { DEFAULT_AGENT_SETTINGS } = await import('../settings/agentSettings');
const { INITIAL } = await import('../../editor/initial');
const { docFromTimeline } = await import('../../persist/projectStore');
const { clearAgentSessionContext } = await import('../../persist/agentRuntimeStore');
type Context = import('../context').AgentContext;
type Middleware = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
const routes = new Map<string, Middleware>();
let apiKey = '';
let provider = '';
const plugin = firecrawlPlugin({ get apiKey() { return apiKey; }, get searchProvider() { return provider; } });
const configure = plugin.configureServer as (server: unknown) => void;
configure({ config: { logger: { info() {}, error() {} } }, middlewares: {
  use(path: string, handler: Middleware) { routes.set(path, handler); },
} });
const server = createServer((req, res) => {
  const handler = routes.get(req.url!);
  if (handler) void handler(req, res);
  else { res.statusCode = 404; res.end(); }
});
server.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address() as import('node:net').AddressInfo;
const origin = `http://127.0.0.1:${address.port}`;
const nativeFetch = globalThis.fetch;
const timeout = AbortSignal.timeout;
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
} });
const outgoing: { url: string; headers: Headers; message: Record<string, unknown> }[] = [];
let responseMode: 'ok' | 'quota' | 'error' | 'invalid' | 'wait' = 'ok';
let firecrawlRequests = 0;
let observedAbort = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('/api/')) return nativeFetch(origin + url, init);
  if (url.startsWith('https://api.firecrawl.dev/')) {
    firecrawlRequests += 1;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer saved-firecrawl-key');
    return Response.json({ data: [{ url: 'https://example.com/firecrawl', title: 'Configured Firecrawl', markdown: 'Saved provider content' }] });
  }
  assert.equal(url, 'https://search.parallel.ai/mcp');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('User-Agent'), 'OpenChatCut (+https://github.com/0xsline/OpenChatCut)');
  assert.equal(headers.get('Authorization'), null, 'no ambient credentials enter anonymous MCP');
  if (init?.method === 'GET') return new Response('', { status: 405 });
  const message = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  outgoing.push({ url, headers, message });
  if (message.id === undefined) return new Response(null, { status: 202 });
  let result: unknown;
  if (message.method === 'initialize') {
    result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'parallel-test', version: '1' } };
  } else if (message.method === 'tools/list') {
    result = { tools: ['web_search', 'web_fetch'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
  } else {
    assert.equal(message.method, 'tools/call');
    if (responseMode === 'quota') return new Response('free anonymous quota exceeded', { status: 429, headers: { 'Retry-After': '60' } });
    if (responseMode === 'wait') {
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => { observedAbort = true; reject(init?.signal?.reason); };
        if (init?.signal?.aborted) cancel();
        else init?.signal?.addEventListener('abort', cancel, { once: true });
      });
    }
    const data = { results: [{ url: 'https://example.com/source', title: 'Source title', excerpts: ['A useful source excerpt.'] }], errors: [] };
    result = responseMode === 'error' ? { isError: true, content: [{ type: 'text', text: 'service unavailable' }] }
      : responseMode === 'invalid' ? { content: [{ type: 'text', text: 'broken JSON' }] }
      : { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }
  return Response.json({ jsonrpc: '2.0', id: message.id, result });
};
const context = (projectId: string): Context => ({
  commands: {} as Context['commands'], getState: () => INITIAL,
  getDoc: () => docFromTimeline(INITIAL), getCreativeMode: () => null,
  templates: [], audio: [], getProjectId: () => projectId,
});
const a = context('web-research-a');
const b = context('web-research-b');
const calls = () => outgoing.filter((entry) => entry.message.method === 'tools/call')
  .map((entry) => entry.message.params as { name: string; arguments: Record<string, unknown> });
async function invoke(name: string, args: Record<string, unknown>, ctx = a, signal?: AbortSignal) {
  const schema = WEB_TOOL_SCHEMAS.find((candidate) => candidate.name === name)!;
  const events: import('../runtime').AgentEvent[] = [];
  const execution = await executeOpenChatCutTool(schema, args, {
    ctx, signal, settings: DEFAULT_AGENT_SETTINGS, onEvent: (event) => events.push(event),
  });
  assert.ok(events.some((event) => event.type === 'tool'), 'result reaches the agent tool event consumer');
  return execution;
}
try {
  const first = await invoke('web_search', { query: 'video script research', limit: 1 });
  assert.equal(first.success, true);
  assert.match(JSON.stringify(first.result), /Source title.*useful source excerpt/);
  assert.equal((first.result as { provider: string }).provider, 'parallel');
  const firstId = calls().at(-1)!.arguments.session_id;
  assert.match(String(firstId), /^[a-f0-9-]{36}$/);
  assert.equal(calls().at(-1)!.arguments.objective, 'video script research');
  assert.deepEqual(calls().at(-1)!.arguments.search_queries, ['video script research']);
  const page = await invoke('web_browser', { url: 'https://example.com/source', query: 'video facts' });
  assert.equal(page.success, true);
  assert.match(JSON.stringify(page.result), /useful source excerpt/);
  assert.equal(calls().at(-1)!.name, 'web_fetch');
  assert.deepEqual(calls().at(-1)!.arguments.urls, ['https://example.com/source']);
  assert.equal(calls().at(-1)!.arguments.session_id, firstId);
  await invoke('web_search', { query: 'follow up' });
  assert.equal(calls().at(-1)!.arguments.session_id, firstId);
  const beforeConcurrent = calls().length;
  await Promise.all([
    invoke('web_search', { query: 'conversation A' }, a),
    invoke('web_search', { query: 'conversation B' }, b),
    invoke('web_browser', { url: 'https://example.com/source' }, b),
  ]);
  const concurrent = calls().slice(beforeConcurrent);
  assert.equal(concurrent.find((call) => call.arguments.objective === 'conversation A')!.arguments.session_id, firstId);
  const secondId = concurrent.find((call) => call.arguments.objective === 'conversation B')!.arguments.session_id;
  assert.notEqual(secondId, firstId);
  assert.equal(concurrent.find((call) => call.name === 'web_fetch')!.arguments.session_id, secondId);
  responseMode = 'quota';
  assert.equal((await invoke('web_search', { query: 'retry boundary' })).success, false);
  responseMode = 'ok';
  await invoke('web_search', { query: 'retry boundary' });
  assert.equal(calls().at(-1)!.arguments.session_id, firstId, 'quota and retry keep the conversation');
  await clearAgentSessionContext('web-research-a');
  await invoke('web_search', { query: 'new chat' });
  assert.notEqual(calls().at(-1)!.arguments.session_id, firstId, 'real chat clear rotates identity');
  const afterResetId = calls().at(-1)!.arguments.session_id;
  const callsBeforeSettings = calls().length;
  apiKey = 'saved-firecrawl-key';
  assert.equal((await invoke('web_search', { query: 'configured search' })).success, true);
  assert.equal(firecrawlRequests, 1);
  assert.equal(calls().length, callsBeforeSettings, 'saved Firecrawl key preserves provider choice');
  await invoke('web_search', { query: 'explicit parallel', provider: 'parallel' });
  assert.equal(calls().at(-1)!.arguments.session_id, afterResetId);
  provider = 'parallel';
  await invoke('web_search', { query: 'saved Parallel overrides key' });
  assert.equal(calls().at(-1)!.arguments.objective, 'saved Parallel overrides key');
  provider = '';
  apiKey = '';
  assert.equal((await invoke('web_search', { query: 'explicit missing Firecrawl', provider: 'firecrawl' })).success, false);
  assert.equal(calls().length, callsBeforeSettings + 2, 'no fallback after explicit provider failure');
  provider = 'firecrawl';
  assert.equal((await invoke('web_search', { query: 'saved choice without key' })).success, false);
  provider = 'disabled';
  assert.equal((await invoke('web_search', { query: 'disabled', provider: 'parallel' })).success, false);
  provider = 'invalid-provider';
  assert.equal((await invoke('web_search', { query: 'invalid setting' })).success, false);
  provider = '';
  const beforeRejected = outgoing.length;
  assert.equal((await invoke('web_browser', { url: 'file:///etc/passwd' })).success, false);
  assert.equal((await invoke('web_browser', { url: 'https://example.com', formats: ['screenshot'] })).success, false);
  assert.equal((await invoke('web_search', { query: 'filtered', country: 'US' })).success, false);
  const denied = await executeOpenChatCutTool(byName.web_search!, { query: 'unavailable tool' }, {
    ctx: a, settings: DEFAULT_AGENT_SETTINGS, activeToolCatalog: [], onEvent() {},
  });
  assert.equal(denied.success, false);
  assert.equal(outgoing.length, beforeRejected, 'validation, unsupported options and permissions cause no outbound traffic');
  for (const mode of ['error', 'invalid'] as const) {
    responseMode = mode;
    assert.equal((await invoke('web_search', { query: mode })).success, false);
  }
  responseMode = 'wait';
  const abort = new AbortController();
  const pendingCall = invoke('web_search', { query: 'cancelled' }, a, abort.signal);
  const cancelTimer = setTimeout(() => abort.abort(), 50);
  assert.equal((await pendingCall).success, false);
  clearTimeout(cancelTimer);
  // Disconnection aborts the middleware's owned MCP request.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(observedAbort, true);
  observedAbort = false;
  assert.equal((await invoke('web_browser', { url: 'https://example.com/source', timeout: 20 })).success, false,
    'page reading honors its requested deadline');
  assert.equal(observedAbort, true, 'the backend deadline aborts the owned MCP request');
  // Accelerate the configured 45-second deadline without changing the path.
  AbortSignal.timeout = (ms) => timeout.call(AbortSignal, ms === 45_000 ? 20 : ms);
  assert.equal((await invoke('web_search', { query: 'timed out' })).success, false);
  assert.equal(firecrawlRequests, 1, 'errors, cancellation and timeouts never switch providers');
  assert.ok(outgoing.some((entry) => entry.message.method === 'initialize'));
  assert.ok(outgoing.some((entry) => entry.message.method === 'tools/list'));
  console.log('web-tools: validated dispatch -> HTTP -> MCP -> source results, provider choices, chat lifecycle, permissions and cancellation passed');
} finally {
  globalThis.fetch = nativeFetch;
  AbortSignal.timeout = timeout;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
