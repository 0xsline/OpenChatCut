import assert from 'node:assert/strict';
import { generateText, jsonSchema } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  defaultModelForProvider,
  getLanguageModel,
  getLanguageModelProviderOptions,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
  providerApiPath,
  sdkProviderName,
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
assert.equal(defaultModelForProvider('openrouter'), 'openrouter/auto');
assert.equal(providerApiPath('anthropic'), '/messages');
assert.equal(providerApiPath('openai'), '/responses');
assert.equal(providerApiPath('openai', 'chat'), '/chat/completions');
assert.equal(providerApiPath('kimi'), '/chat/completions');
assert.equal(providerApiPath('openrouter'), '/chat/completions');
assert.equal(normalizeOpenAiApiMode('chat'), 'chat');
assert.equal(normalizeOpenAiApiMode('unexpected'), 'responses');
assert.equal(getLanguageModel('anthropic', 'test-model').provider, 'anthropic.messages');
assert.equal(getLanguageModel('openai', 'test-model').provider, 'openai.responses');
assert.equal(getLanguageModel('openai', 'test-model', 'chat').provider, 'openai.chat');
assert.equal(getLanguageModel('kimi', 'test-model').provider, 'kimi.chat');
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
  assert.equal(
    getLanguageModel(preset.id, 'test-model').provider,
    preset.protocol === 'anthropic'
      ? 'anthropic.messages'
      : preset.protocol === 'openai'
        ? 'openai.responses'
        // gemini 实例名固定 'google'(thought_signature 捕获/重放键必须对齐)
        : `${sdkProviderName(preset.id)}.chat`,
  );
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

let geminiRequest: Record<string, unknown> | undefined;
const gemini = createOpenAICompatible({
  name: sdkProviderName('gemini'),
  baseURL: 'https://example.invalid/v1beta/openai',
  apiKey: 'test-key',
  fetch: async (_input, init) => {
    geminiRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ error: { message: 'intentional test response' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  },
});
await assert.rejects(generateText({
  model: gemini('gemini-test'),
  messages: prepareMessagesForProvider([
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'gemini_tool_1',
        toolName: 'edit_item',
        input: { itemId: 'a' },
        providerOptions: { google: { thoughtSignature: 'gemini-signature' } },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'gemini_tool_1',
        toolName: 'edit_item',
        output: { type: 'text', value: '{"ok":true}' },
      }],
    },
  ], 'gemini', 'gemini'),
  maxRetries: 0,
}));
const geminiToolCall = ((geminiRequest?.messages as Array<Record<string, unknown>>)[0]
  .tool_calls as Array<Record<string, unknown>>)[0];
assert.equal(
  (geminiToolCall.extra_content as { google: { thought_signature: string } })
    .google.thought_signature,
  'gemini-signature',
);

// ── Gemini thought_signature 全环路回归(#6 二报):真实响应捕获 → response
// messages → 下一请求重放。签名由传输层存进 providerMetadata[<实例名>],出向只读
// providerOptions.google —— 实例名必须是 'google'(sdkProviderName),否则第二跳
// 丢签名,Gemini 400 "missing a thought_signature in functionCall parts"。
{
  const requests: Record<string, unknown>[] = [];
  const roundtrip = createOpenAICompatible({
    name: sdkProviderName('gemini'),
    baseURL: 'https://example.invalid/v1beta/openai',
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        // 首跳:模型返回带 extra_content 签名的 tool call(Gemini 实际线上形态)
        return new Response(JSON.stringify({
          id: 'r1', object: 'chat.completion', created: 0, model: 'gemini-test',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'live_tc_1', type: 'function',
                function: { name: 'edit_track', arguments: '{"trackId":"V1"}' },
                extra_content: { google: { thought_signature: 'live-signature' } },
              }],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'stop after capture' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const first = await generateText({
    model: roundtrip('gemini-test'),
    prompt: 'switch track',
    tools: { edit_track: { inputSchema: jsonSchema({ type: 'object' }) } },
    maxRetries: 0,
  });
  // 二跳:把首跳的 response.messages(含工具结果)原样重放 —— 模拟循环内下一步/下一轮
  await assert.rejects(generateText({
    model: roundtrip('gemini-test'),
    messages: [
      ...first.response.messages,
      {
        role: 'tool',
        content: [{
          type: 'tool-result', toolCallId: 'live_tc_1', toolName: 'edit_track',
          output: { type: 'text', value: '{"ok":true}' },
        }],
      },
    ],
    maxRetries: 0,
  }));
  const replayAssistant = (requests[1].messages as Array<Record<string, unknown>>)
    .find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))!;
  const replayCall = (replayAssistant.tool_calls as Array<Record<string, unknown>>)[0];
  assert.equal(
    (replayCall.extra_content as { google: { thought_signature: string } } | undefined)
      ?.google.thought_signature,
    'live-signature',
    'captured thought_signature must survive into the replayed functionCall',
  );
}

console.log('ai-sdk checks passed');
