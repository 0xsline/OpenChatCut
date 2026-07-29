import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createMiniConnect } from '../desktop/mini-connect.ts';
import {
  expandLlmProviderPatch,
  llmOperationPath,
  resolveLlmBaseUrl,
} from './llm-config.ts';
import { proxyMiddleware } from './proxy.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

assert.equal(resolveLlmBaseUrl('anthropic', ''), 'https://api.anthropic.com/v1');
assert.equal(resolveLlmBaseUrl('kimi', ''), 'https://api.moonshot.ai/v1');
assert.equal(resolveLlmBaseUrl('qwen', ''), 'https://dashscope-us.aliyuncs.com/compatible-mode/v1');
assert.equal(resolveLlmBaseUrl('glm', ''), 'https://open.bigmodel.cn/api/paas/v4');
assert.equal(resolveLlmBaseUrl('deepseek', ''), 'https://api.deepseek.com');
assert.equal(resolveLlmBaseUrl('minimax', ''), 'https://api.minimaxi.com/v1');
assert.equal(resolveLlmBaseUrl('gemini', ''), 'https://generativelanguage.googleapis.com/v1beta');
assert.equal(resolveLlmBaseUrl('openai', 'https://api.openai.com', ''), 'https://api.openai.com/v1');
assert.equal(resolveLlmBaseUrl('anthropic', 'https://relay.test/api', ''), 'https://relay.test/api/v1');
assert.equal(llmOperationPath('kimi'), '/chat/completions');

// ── llmHeaders: Inject upstream authentication according to the protocol (google=x-goog-api-key;anthropic=x-api-key; the rest Bearer) ──
{
  const { KEY_NAMES, seedKeystore } = await import('./keystore.ts');
  const { llmErrorMessage, llmHeaders } = await import('./plugins/llm-proxy.ts');
  seedKeystore({
    ...Object.fromEntries(KEY_NAMES.map((name) => [name, ''])),
    LLM_PROVIDER: 'anthropic',
    LLM_GEMINI_API_KEY: 'gk-1',
    LLM_MINIMAX_API_KEY: 'mk-1',
    LLM_API_KEY: 'ak-1',
  } as Record<string, string>);
  const reqFor = (provider: string) => ({ headers: { 'x-openchatcut-provider': provider } } as never);
  assert.deepEqual(llmHeaders(reqFor('gemini')), { 'x-goog-api-key': 'gk-1' }, 'gemini 原生协议注入 x-goog-api-key');
  assert.deepEqual(llmHeaders(reqFor('minimax')), { authorization: 'Bearer mk-1' }, 'openai-compatible 厂商 Bearer');
  assert.deepEqual(llmHeaders(reqFor('anthropic')), { 'x-api-key': 'ak-1', 'anthropic-version': '2023-06-01' }, 'anthropic x-api-key(经遗留迁移)');
  assert.match(llmErrorMessage(401, reqFor('gemini')), /Gemini.*设置.*API Key/, '认证错误给设置入口');
  assert.match(llmErrorMessage(429, reqFor('openai')), /额度不足.*稍后重试/, '限流错误给额度提示');
}

const switched = expandLlmProviderPatch(new Map([['LLM_PROVIDER', 'openai']]), 'anthropic');
assert.deepEqual(Object.fromEntries(switched), {
  LLM_PROVIDER: 'openai',
  LLM_MODEL: '',
  LLM_BASE_URL: '',
});
const explicit = expandLlmProviderPatch(new Map([
  ['LLM_PROVIDER', 'openai'],
  ['LLM_MODEL', 'gpt-custom'],
  ['LLM_BASE_URL', 'https://relay.test/v2'],
]), 'anthropic');
assert.equal(explicit.get('LLM_MODEL'), 'gpt-custom');
assert.equal(explicit.get('LLM_BASE_URL'), 'https://relay.test/v2');

const seen: Array<{ url: string; authorization?: string; provider?: string; body: string }> = [];
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  seen.push({
    url: req.url ?? '',
    authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    provider: typeof req.headers['x-openchatcut-provider'] === 'string'
      ? req.headers['x-openchatcut-provider']
      : undefined,
    body: Buffer.concat(chunks).toString('utf8'),
  });
  if (req.url?.includes('/unauthorized')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"vendor_auth_error","secret_debug":"raw body must stay hidden"}}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('{"ok":true}');
});
const upstreamPort = await listen(upstream);

let target = `http://127.0.0.1:${upstreamPort}/v1beta/openai?api-version=preview`;
const app = createMiniConnect((error) => { throw error; });
app.use('/llm', proxyMiddleware({
  target: () => target,
  headers: () => ({ authorization: 'Bearer server-secret' }),
  forceJsonContentType: true,
  errorMessage: (status) => `Friendly provider error (${status}). Check Agent settings.`,
}));
const proxy = createServer(app.handle);
const proxyPort = await listen(proxy);

try {
  const first = await fetch(`http://127.0.0.1:${proxyPort}/llm/chat/completions?stream=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openchatcut-provider': 'kimi' },
    body: '{"model":"compatible"}',
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/json');
  assert.deepEqual(await first.json(), { ok: true });

  target = `http://127.0.0.1:${upstreamPort}/v1`;
  await fetch(`http://127.0.0.1:${proxyPort}/llm/responses`, {
    method: 'POST',
    body: '{"model":"openai"}',
  });

  assert.deepEqual(seen, [
    {
      url: '/v1beta/openai/chat/completions?api-version=preview&stream=true',
      authorization: 'Bearer server-secret',
      provider: undefined,
      body: '{"model":"compatible"}',
    },
    {
      url: '/v1/responses',
      authorization: 'Bearer server-secret',
      provider: undefined,
      body: '{"model":"openai"}',
    },
  ]);

  const denied = await fetch(`http://127.0.0.1:${proxyPort}/llm/unauthorized`);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), {
    error: { message: 'Friendly provider error (401). Check Agent settings.' },
  }, 'raw provider JSON is replaced with one actionable message');
} finally {
  await close(proxy);
  await close(upstream);
}

console.log('llm proxy checks passed');
