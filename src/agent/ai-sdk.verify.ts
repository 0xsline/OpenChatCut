import assert from 'node:assert/strict';
import { generateText, jsonSchema } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import {
  defaultModelForProvider,
  getLanguageModel,
  getLanguageModelProviderOptions,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  providerApiPath,
} from './client';
import { LLM_PROVIDER_PRESETS } from '../../shared/llm-providers';
import {
  makeMessagesPortable,
  normalizeLlmMessages,
  prepareMessagesForProvider,
} from './messages';

assert.equal(normalizeLlmProvider('openai'), 'openai');
assert.equal(normalizeLlmProvider('KIMI'), 'kimi');
assert.equal(normalizeLlmProvider('qwen'), 'qwen');
assert.equal(normalizeLlmProvider('glm'), 'glm');
assert.equal(normalizeLlmProvider('OpenRouter'), 'openrouter');
assert.equal(normalizeLlmProvider('unexpected'), 'anthropic');
assert.equal(defaultModelForProvider('anthropic'), 'claude-fable-5');
assert.equal(defaultModelForProvider('openai'), 'gpt-5');
assert.equal(defaultModelForProvider('kimi'), 'kimi-k3');
assert.equal(defaultModelForProvider('qwen'), 'qwen-plus');
assert.equal(defaultModelForProvider('glm'), 'glm-5.2');
assert.equal(defaultModelForProvider('zai-coding'), 'glm-5.2');
assert.equal(defaultModelForProvider('openrouter'), 'openrouter/auto');
assert.equal(providerApiPath('anthropic'), '/messages');
assert.equal(providerApiPath('openai'), '/responses');
assert.equal(providerApiPath('openai', 'chat'), '/chat/completions');
assert.equal(providerApiPath('kimi'), '/chat/completions');
assert.equal(providerApiPath('gemini'), '/models');
assert.equal(providerApiPath('openrouter'), '/chat/completions');
assert.equal(normalizeOpenAiApiMode('chat'), 'chat');
assert.equal(normalizeOpenAiApiMode('unexpected'), 'responses');
assert.equal(getLanguageModel('anthropic', 'test-model').provider, 'anthropic.messages');
assert.equal(getLanguageModel('openai', 'test-model').provider, 'openai.responses');
assert.equal(getLanguageModel('openai', 'test-model', 'chat').provider, 'openai.chat');
assert.equal(getLanguageModel('kimi', 'test-model').provider, 'moonshotai.chat');
assert.equal(getLanguageModel('gemini', 'test-model').provider, 'google.generative-ai');
assert.equal(getLanguageModel('openrouter', 'openrouter/auto').provider, 'openrouter.chat');
assert.deepEqual(getLanguageModelProviderOptions('openai'), { openai: { store: false } });
assert.equal(getLanguageModelProviderOptions('openai', 'chat'), undefined);
assert.deepEqual(getLanguageModelProviderOptions('minimax'), {
  minimax: { reasoning_split: true },
});
assert.equal(
  new Set(LLM_PROVIDER_PRESETS.map(({ id }) => id)).size,
  LLM_PROVIDER_PRESETS.length,
);
for (const preset of LLM_PROVIDER_PRESETS) {
  assert.equal(normalizeLlmProvider(preset.id), preset.id);
  assert.equal(defaultModelForProvider(preset.id), preset.defaultModel);
  assert.doesNotThrow(() => new URL(preset.baseUrl));
  // SDK provider id depends on wire protocol: anthropic/openai/google are native
  // protocols; kimi/qwen/deepseek/mistral use dedicated vendor SDK packages; everything
  // else (openai-compatible) → '<id>.chat'. Protocol-driven so anthropic-speaking presets
  // (e.g. maxplus-grok) resolve to 'anthropic.messages' rather than '<id>.chat'.
  const DEDICATED_SDK_PROVIDER_ID: Record<string, string> = {
    kimi: 'moonshotai.chat',
    qwen: 'alibaba.chat',
    deepseek: 'deepseek.chat',
    mistral: 'mistral.chat',
  };
  const expectedSdkId =
    preset.protocol === 'anthropic' ? 'anthropic.messages'
    : preset.protocol === 'openai' ? 'openai.responses'
    : preset.protocol === 'google' ? 'google.generative-ai'
    : DEDICATED_SDK_PROVIDER_ID[preset.id] ?? `${preset.id}.chat`;
  assert.equal(getLanguageModel(preset.id, 'test-model').provider, expectedSdkId);
}

// Exercise the real AI SDK provider serializers without making a network call.
// A controlled 400 is sufficient to capture each protocol's URL and request body.
const originalFetch = globalThis.fetch;
const serialized: Array<{ url: string; body: Record<string, unknown>; provider: string | null }> = [];
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  serialized.push({
    url,
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    provider: headers.get('x-openchatcut-provider'),
  });
  return new Response(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'intentional test response' },
  }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
};
try {
  for (const [provider, model, openAiApiMode] of [
    ['anthropic', 'claude-test', undefined],
    ['openai', 'gpt-test', undefined],
    ['openai', 'gpt-chat-test', 'chat'],
    ['kimi', 'kimi-test', undefined],
  ] as const) {
    await assert.rejects(generateText({
      model: getLanguageModel(provider, model, openAiApiMode),
      prompt: 'ping',
      maxRetries: 0,
    }));
  }
} finally {
  globalThis.fetch = originalFetch;
}
assert.deepEqual(serialized.map(({ url, body, provider }) => ({
  path: new URL(url).pathname,
  model: body.model,
  provider,
})), [
  { path: '/llm/messages', model: 'claude-test', provider: 'anthropic' },
  { path: '/llm/responses', model: 'gpt-test', provider: 'openai' },
  { path: '/llm/chat/completions', model: 'gpt-chat-test', provider: 'openai' },
  { path: '/llm/chat/completions', model: 'kimi-test', provider: 'kimi' },
]);

const legacy = normalizeLlmMessages([
  { role: 'user', content: '把第一段放到时间线' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private reasoning', signature: 'sig' },
      { type: 'text', text: '开始处理。' },
      { type: 'tool_use', id: 'tool_1', name: 'edit_item', input: { itemId: 'a' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tool_1', content: '{"ok":true}' },
    ],
  },
]);

assert.deepEqual(legacy, [
  { role: 'user', content: '把第一段放到时间线' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '开始处理。' },
      { type: 'tool-call', toolCallId: 'tool_1', toolName: 'edit_item', input: { itemId: 'a' } },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'tool_1',
        toolName: 'edit_item',
        output: { type: 'text', value: '{"ok":true}' },
      },
    ],
  },
]);

const portable = prepareMessagesForProvider([
  {
    role: 'assistant',
    providerOptions: { anthropic: { container: 'abc' } },
    content: [
      { type: 'reasoning', text: 'hidden', providerOptions: { anthropic: { signature: 'sig' } } },
      { type: 'text', text: 'visible', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
    ],
  },
], 'anthropic', 'openai');

assert.deepEqual(portable, [
  { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
]);
assert.deepEqual(makeMessagesPortable([
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'hidden', providerOptions: { openai: { itemId: 'rs_1' } } },
      { type: 'text', text: 'visible', providerOptions: { openai: { itemId: 'msg_1' } } },
    ],
  },
]), [
  { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
]);

// ── Gemini(官方 @ai-sdk/google,原生 API)thought_signature 全环路回归(#6):
// 首跳原生响应携带 parts[].thoughtSignature → 捕获进 response messages →
// 经 prepareMessagesForProvider 同厂商重放 → 二跳请求的 functionCall part 必须
// 带回同一签名(Gemini 3 循环内强校验,丢了就是 400)。
{
  const urls: string[] = [];
  const headerKeys: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const google = createGoogleGenerativeAI({
    baseURL: 'https://example.invalid/v1beta',
    apiKey: 'test-key',
    fetch: async (input, init) => {
      urls.push(String(input));
      headerKeys.push(String(new Headers(init?.headers).get('x-goog-api-key')));
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                functionCall: { name: 'edit_track', args: { trackId: 'V1' } },
                thoughtSignature: 'live-signature',
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { code: 400, message: 'stop after capture' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const first = await generateText({
    model: google('gemini-test'),
    prompt: 'switch track',
    tools: { edit_track: { inputSchema: jsonSchema({ type: 'object' }) } },
    maxRetries: 0,
  });
  assert.ok(urls[0].includes('/models/gemini-test:generateContent'), '原生模型路径');
  assert.equal(headerKeys[0], 'test-key', '鉴权走 x-goog-api-key(代理端将覆盖为真实 key)');
  const captured = first.response.messages.find((m) => m.role === 'assistant');
  assert.ok(captured, 'first hop yields an assistant message');
  // 二跳:经我们的历史管道(同厂商保留 providerOptions)重放 + 工具结果
  await assert.rejects(generateText({
    model: google('gemini-test'),
    messages: prepareMessagesForProvider([
      ...first.response.messages,
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: (captured!.content as Array<{ type: string; toolCallId?: string }>)
            .find((p) => p.type === 'tool-call')!.toolCallId!,
          toolName: 'edit_track',
          output: { type: 'text', value: '{"ok":true}' },
        }],
      },
    ], 'gemini', 'gemini'),
    maxRetries: 0,
  }));
  const contents = requests[1].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const fcPart = contents.flatMap((c) => c.parts).find((p) => p.functionCall);
  assert.ok(fcPart, 'replayed request contains the functionCall part');
  assert.equal(fcPart!.thoughtSignature, 'live-signature',
    'captured thought_signature must survive into the replayed functionCall part');
}

// ── kimi/qwen/deepseek/mistral 官方包线型:都打 {base}/chat/completions + Bearer,
// 与 /llm 代理契约一致(代理端按厂商覆盖真实 key);payload 含 model+messages。──
{
  const { createMoonshotAI } = await import('@ai-sdk/moonshotai');
  const { createAlibaba } = await import('@ai-sdk/alibaba');
  const { createDeepSeek } = await import('@ai-sdk/deepseek');
  const { createMistral } = await import('@ai-sdk/mistral');
  const cases: Array<[string, (o: { baseURL: string; apiKey: string; fetch: typeof fetch }) => (m: string) => Parameters<typeof generateText>[0]['model']]> = [
    ['moonshotai', createMoonshotAI],
    ['alibaba', createAlibaba],
    ['deepseek', createDeepSeek],
    ['mistral', createMistral],
  ];
  for (const [label, create] of cases) {
    let url = '';
    let auth = '';
    let body: Record<string, unknown> = {};
    const provider = create({
      baseURL: 'https://example.invalid/llm',
      apiKey: 'proxy-key',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        auth = String(new Headers(init?.headers).get('authorization'));
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ error: { message: 'stop' } }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await assert.rejects(generateText({ model: provider('test-model'), prompt: 'hi', maxRetries: 0 }));
    assert.ok(url.endsWith('/llm/chat/completions'), `${label}: /chat/completions 路径(got ${url})`);
    assert.equal(auth, 'Bearer proxy-key', `${label}: Bearer 鉴权`);
    assert.equal(body.model, 'test-model', `${label}: model 字段`);
    assert.ok(Array.isArray(body.messages), `${label}: messages 数组`);
  }
}

console.log('ai-sdk checks passed');
