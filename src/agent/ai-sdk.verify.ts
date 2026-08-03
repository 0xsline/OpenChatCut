import assert from 'node:assert/strict';
import {
  UnsupportedFunctionalityError,
  generateText,
  jsonSchema,
  simulateReadableStream,
  tool,
  type ModelMessage,
  type ToolResultPart,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
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
  prepareChatCompletionsMediaMessages,
  withoutModelImages,
} from './messages';
import {
  apiToolExecutionOutput,
  isCompatibleMediaFallbackError,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './runtime';
import type { AgentEvent } from './runtime';
import { runApiAgent } from './api-runtime';
import { resolveModelCapabilities } from '../../shared/model-capabilities';
import type { AgentContext } from './context';
import { INITIAL } from '../editor/initial';
import { docFromTimeline } from '../persist/projectStore';
import { isFailedToolResult, ToolFailureTracker } from './toolFailure';

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
assert.equal(providerApiPath('gemini'), '/models');
assert.equal(providerApiPath('openrouter'), '/chat/completions');

const strippedVisualMessages = withoutModelImages([{
  role: 'user',
  content: [
    { type: 'text', text: 'inspect this' },
    { type: 'file', data: new URL('https://example.invalid/frame.png'), mediaType: 'image/png' },
    { type: 'file', data: new URL('https://example.invalid/notes.pdf'), mediaType: 'application/pdf' },
  ],
}]);
const strippedVisualContent = strippedVisualMessages[0]!.content as Array<Record<string, unknown>>;
assert.equal(strippedVisualContent.some((part) => part.mediaType === 'image/png'), false,
  'models without image input never receive visual attachments');
assert.equal(strippedVisualContent.some((part) => part.mediaType === 'application/pdf'), true,
  'non-image files are not conflated with image capability');
assert.equal(strippedVisualContent.some((part) => String(part.text).includes('omitted')), true,
  'the model receives an explicit omission notice');
assert.equal(normalizeOpenAiApiMode('chat'), 'chat');
assert.equal(normalizeOpenAiApiMode('unexpected'), 'responses');
assert.equal((await getLanguageModel('anthropic', 'test-model')).provider, 'anthropic.messages');
assert.equal((await getLanguageModel('openai', 'test-model')).provider, 'openai.responses');
assert.equal((await getLanguageModel('openai', 'test-model', 'chat')).provider, 'openai.chat');
assert.equal((await getLanguageModel('kimi', 'test-model')).provider, 'moonshotai.chat');
assert.equal((await getLanguageModel('gemini', 'test-model')).provider, 'google.generative-ai');
assert.equal((await getLanguageModel('openrouter', 'openrouter/auto')).provider, 'openrouter.chat');
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
  // Providers with official exclusive packages use the official package (provider id varies from package to package); the rest are openai-compatible
  const DEDICATED_PROVIDER_IDS: Record<string, string> = {
    anthropic: 'anthropic.messages',
    openai: 'openai.responses',
    gemini: 'google.generative-ai',
    kimi: 'moonshotai.chat',
    qwen: 'alibaba.chat',
    deepseek: 'deepseek.chat',
    mistral: 'mistral.chat',
  };
  assert.equal(
    (await getLanguageModel(preset.id, 'test-model')).provider,
    DEDICATED_PROVIDER_IDS[preset.id] ?? `${preset.id}.chat`,
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
      model: await getLanguageModel(provider, model, openAiApiMode),
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

// OpenAI Chat Completions only supports vision input on user messages. If a
// tool-result file stays inside the tool message, the provider serializes its
// base64 bytes as plain text and can exhaust the model context window.
const chatVisionHistory = makeMessagesPortable([
  {
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'frame_call',
      toolName: 'view_asset_frames',
      input: { assetId: 'asset-a' },
    }],
  },
  {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'frame_call',
      toolName: 'view_asset_frames',
      output: {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'data', data: 'jpeg-base64' },
            mediaType: 'image/jpeg',
            filename: 'frame-0.jpg',
          },
          { type: 'text', text: 'frame 0 metadata' },
        ],
      },
    }],
  },
], 'chat');
assert.deepEqual(chatVisionHistory, [
  {
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'frame_call',
      toolName: 'view_asset_frames',
      input: { assetId: 'asset-a' },
    }],
  },
  {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'frame_call',
      toolName: 'view_asset_frames',
      output: { type: 'text', value: 'frame 0 metadata' },
    }],
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Rendered media returned by the preceding tool calls:' },
      {
        type: 'file',
        data: { type: 'data', data: 'jpeg-base64' },
        mediaType: 'image/jpeg',
        filename: 'frame-0.jpg',
      },
    ],
  },
]);

const compatibleAssistant: ModelMessage = {
  role: 'assistant',
  providerOptions: { moonshotai: { history: 'keep' } },
  content: [{
    type: 'reasoning',
    text: 'provider reasoning',
    providerOptions: { moonshotai: { reasoningContent: 'keep' } },
  }],
};
const compatibleTextResult: ToolResultPart = {
  type: 'tool-result',
  toolCallId: 'text_call',
  toolName: 'inspect_metadata',
  providerOptions: { moonshotai: { result: 'keep' } },
  output: {
    type: 'text',
    value: 'metadata only',
    providerOptions: { moonshotai: { output: 'keep' } },
  },
};
const compatibleTextTool: ModelMessage = {
  role: 'tool',
  providerOptions: { moonshotai: { message: 'keep' } },
  content: [compatibleTextResult],
};
const compatibleFileResultA: ToolResultPart = {
  type: 'tool-result',
  toolCallId: 'frame_call_a',
  toolName: 'view_asset_frames',
  providerOptions: { moonshotai: { result: 'keep-a' } },
  output: {
    type: 'content',
    value: [{
      type: 'file',
      data: { type: 'data', data: 'compatible-jpeg-a' },
      mediaType: 'image/jpeg',
      filename: 'frame-a.jpg',
      providerOptions: { moonshotai: { file: 'keep-a' } },
    }],
  },
};
const compatibleFileResultB: ToolResultPart = {
  type: 'tool-result',
  toolCallId: 'frame_call_b',
  toolName: 'view_asset_frames',
  providerOptions: { moonshotai: { result: 'keep-b' } },
  output: {
    type: 'content',
    value: [
      { type: 'text', text: 'frame b metadata', providerOptions: { moonshotai: { text: 'keep-b' } } },
      {
        type: 'file',
        data: { type: 'data', data: 'compatible-jpeg-b' },
        mediaType: 'image/jpeg',
      },
    ],
  },
};
const compatibleFileToolA: ModelMessage = {
  role: 'tool',
  providerOptions: { moonshotai: { message: 'keep-a' } },
  content: [compatibleFileResultA],
};
const compatibleFileToolB: ModelMessage = {
  role: 'tool',
  providerOptions: { moonshotai: { message: 'keep-b' } },
  content: [compatibleFileResultB],
};
const compatibleMediaPreparation = prepareChatCompletionsMediaMessages([
  compatibleAssistant,
  compatibleTextTool,
  compatibleFileToolA,
  compatibleFileToolB,
]);
const compatibleChatHistory = compatibleMediaPreparation.messages;
assert.equal(compatibleMediaPreparation.movedMedia, true);
assert.equal(compatibleChatHistory.length, 5);
assert.strictEqual(compatibleChatHistory[0], compatibleAssistant);
assert.strictEqual(compatibleChatHistory[1], compatibleTextTool);
assert.strictEqual(
  (compatibleChatHistory[1] as Extract<ModelMessage, { role: 'tool' }>).content[0],
  compatibleTextResult,
);
assert.deepEqual(compatibleChatHistory.slice(2), [
  {
    ...compatibleFileToolA,
    content: [{
      ...compatibleFileResultA,
      output: {
        type: 'text',
        value: 'Rendered media is attached in the following user message.',
      },
    }],
  },
  {
    ...compatibleFileToolB,
    content: [{
      ...compatibleFileResultB,
      output: {
        type: 'text',
        value: 'frame b metadata',
        providerOptions: { moonshotai: { text: 'keep-b' } },
      },
    }],
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Rendered media returned by the preceding tool calls:' },
      {
        type: 'file',
        data: { type: 'data', data: 'compatible-jpeg-a' },
        mediaType: 'image/jpeg',
        filename: 'frame-a.jpg',
        providerOptions: { moonshotai: { file: 'keep-a' } },
      },
      {
        type: 'file',
        data: { type: 'data', data: 'compatible-jpeg-b' },
        mediaType: 'image/jpeg',
      },
    ],
  },
]);

const compatibleTextOnlyHistory = compatibleMediaPreparation.messagesWithoutMedia;
assert.equal(compatibleTextOnlyHistory.length, 4);
assert.strictEqual(compatibleTextOnlyHistory[0], compatibleAssistant);
assert.strictEqual(compatibleTextOnlyHistory[1], compatibleTextTool);
assert.deepEqual(compatibleTextOnlyHistory.slice(2), [
  {
    ...compatibleFileToolA,
    content: [{
      ...compatibleFileResultA,
      output: {
        type: 'text',
        value: 'Rendered media was omitted because the selected model does not accept visual attachments.',
      },
    }],
  },
  {
    ...compatibleFileToolB,
    content: [{
      ...compatibleFileResultB,
      output: {
        type: 'text',
        value: 'frame b metadata',
        providerOptions: { moonshotai: { text: 'keep-b' } },
      },
    }],
  },
]);
for (const message of compatibleTextOnlyHistory) {
  if (message.role === 'user' && Array.isArray(message.content)) {
    assert.equal(message.content.some((part) => part.type === 'file'), false);
  }
  if (message.role === 'tool') {
    for (const part of message.content) {
      if (part.type === 'tool-result') assert.notEqual(part.output.type, 'content');
    }
  }
}

const compatibleNoMediaPreparation = prepareChatCompletionsMediaMessages([
  compatibleAssistant,
  compatibleTextTool,
]);
assert.equal(compatibleNoMediaPreparation.movedMedia, false);
assert.strictEqual(compatibleNoMediaPreparation.messages[0], compatibleAssistant);
assert.strictEqual(compatibleNoMediaPreparation.messages[1], compatibleTextTool);
assert.strictEqual(compatibleNoMediaPreparation.messagesWithoutMedia[0], compatibleAssistant);
assert.strictEqual(compatibleNoMediaPreparation.messagesWithoutMedia[1], compatibleTextTool);

const retryable400 = {
  protocol: 'openai-compatible',
  movedMedia: true,
  retryAttempted: false,
  outputStarted: false,
  aborted: false,
  error: { statusCode: 400 },
};
const unsupportedImageInput = new UnsupportedFunctionalityError({
  functionality: 'image input',
});
assert.equal(streamPartStartsCompatibleMediaOutput('error'), false);
assert.equal(streamPartStartsCompatibleMediaOutput('abort'), false);
assert.equal(streamPartStartsCompatibleMediaOutput('text-start'), true);
assert.equal(streamPartStartsCompatibleMediaOutput('reasoning-delta'), true);
assert.equal(streamPartStartsCompatibleMediaOutput('tool-input-start'), true);
assert.equal(isCompatibleMediaFallbackError(unsupportedImageInput), true);
assert.equal(isCompatibleMediaFallbackError({ status: 400 }), true);
assert.equal(shouldRetryCompatibleMediaRequest(retryable400), true);
assert.equal(shouldRetryCompatibleMediaRequest({
  ...retryable400,
  error: unsupportedImageInput,
}), true);
assert.equal(shouldRetryCompatibleMediaRequest({ ...retryable400, retryAttempted: true }), false);
for (const statusCode of [401, 403, 404, 429, 500, 503]) {
  assert.equal(shouldRetryCompatibleMediaRequest({
    ...retryable400,
    error: { statusCode },
  }), false);
}
assert.equal(shouldRetryCompatibleMediaRequest({
  ...retryable400,
  error: Object.assign(new Error('aborted'), { name: 'AbortError', statusCode: 400 }),
}), false);
assert.equal(shouldRetryCompatibleMediaRequest({ ...retryable400, aborted: true }), false);
assert.equal(shouldRetryCompatibleMediaRequest({ ...retryable400, outputStarted: true }), false);
assert.equal(shouldRetryCompatibleMediaRequest({ ...retryable400, movedMedia: false }), false);
for (const protocol of ['openai', 'anthropic', 'google']) {
  assert.equal(shouldRetryCompatibleMediaRequest({ ...retryable400, protocol }), false);
}

assert.deepEqual(makeMessagesPortable([compatibleFileToolA], 'responses'), [{
  role: 'tool',
  content: [{
    type: 'tool-result',
    toolCallId: 'frame_call_a',
    toolName: 'view_asset_frames',
    output: {
      type: 'content',
      value: [{
        type: 'file',
        data: { type: 'data', data: 'compatible-jpeg-a' },
        mediaType: 'image/jpeg',
        filename: 'frame-a.jpg',
      }],
    },
  }],
}]);
const nativeMediaHistory = prepareMessagesForProvider(
  [compatibleFileToolA],
  'gemini',
  'gemini',
);
assert.equal(nativeMediaHistory.length, 1);
assert.strictEqual(nativeMediaHistory[0], compatibleFileToolA);

// ── Gemini (official @ai-sdk/google, native API) thought_signature full loop regression (#6):
// The first hop native response carries parts[].thoughtSignature → captured into response messages →
// Replayed by prepareMessagesForProvider with the same provider → the functionCall part of the second-hop request must
// Bring back the same signature (Strong verification in Gemini 3 cycle, if lost, it will be 400).
{
  const urls: string[] = [];
  const headerKeys: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
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
  // Second hop: Replay + tool results through our history pipeline (same vendor reserved providerOptions)
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

// ── kimi/qwen/deepseek/mistral Official package type: {base}/chat/completions + Bearer,
// Consistent with the /llm proxy contract (the proxy overwrites the real key according to the provider); the payload contains model+messages. ──
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

assert.equal(shouldRetryTransientAgentRequest({
  retryAttempted: false,
  outputStarted: false,
  aborted: false,
  error: Object.assign(new Error('temporary gateway failure'), { statusCode: 502 }),
}), true, 'retry one transient gateway failure before output starts');
assert.equal(shouldRetryTransientAgentRequest({
  retryAttempted: false,
  outputStarted: false,
  aborted: false,
  error: new TypeError('Failed to fetch'),
}), true, 'retry a canonical browser fetch failure before output starts');
assert.equal(shouldRetryTransientAgentRequest({
  retryAttempted: false,
  outputStarted: false,
  aborted: false,
  error: Object.assign(new Error('request aborted'), { name: 'AbortError' }),
}), false, 'never retry an aborted browser request');
assert.equal(shouldRetryTransientAgentRequest({
  retryAttempted: false,
  outputStarted: false,
  aborted: false,
  error: Object.assign(new Error('bad request'), { statusCode: 400 }),
}), false, 'do not retry permanent request failures');
assert.equal(shouldRetryTransientAgentRequest({
  retryAttempted: false,
  outputStarted: true,
  aborted: false,
  error: Object.assign(new Error('late gateway failure'), { statusCode: 502 }),
}), false, 'do not duplicate a request after visible output starts');
assert.equal(shouldRetryTransientAgentRequest({
  retryAttempted: true,
  outputStarted: false,
  aborted: false,
  error: Object.assign(new Error('second gateway failure'), { statusCode: 503 }),
}), false, 'a transient request retries at most once');

assert.equal(isFailedToolResult({ ok: false, error: 'unknown item' }), true);
assert.equal(isFailedToolResult({ error: 'invalid edit_item input' }), true);
assert.equal(isFailedToolResult({ ok: true, error: 'non-fatal diagnostic' }), false);
assert.equal(isFailedToolResult({ success: true, result: null }), false);
assert.throws(
  () => apiToolExecutionOutput({
    success: false,
    result: { ok: false, error: 'updates[0]: item not found' },
  }),
  /updates\[0\]: item not found/,
  'API tools must surface rejected result envelopes as AI SDK tool errors',
);
assert.deepEqual(
  apiToolExecutionOutput({ success: true, result: { ok: true, changed: 1 } }),
  { ok: true, changed: 1 },
);

const sdkToolFailure = await generateText({
  model: new MockLanguageModelV4({
    doGenerate: {
      content: [{
        type: 'tool-call',
        toolCallId: 'failed-edit',
        toolName: 'edit_item',
        input: '{"updates":[{"itemId":"missing"}]}',
      }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    },
  }),
  prompt: 'Edit a missing clip.',
  tools: {
    edit_item: tool({
      inputSchema: jsonSchema({ type: 'object' }),
      execute: async () => apiToolExecutionOutput({
        success: false,
        result: { ok: false, error: 'updates[0]: item not found' },
      }),
    }),
  },
  maxRetries: 0,
});
assert.equal(
  sdkToolFailure.steps[0]?.content.some((part) => part.type === 'tool-error'),
  true,
  'AI SDK must preserve rejected OpenChatCut results as tool-error parts',
);

const apiContext: AgentContext = {
  commands: {} as AgentContext['commands'],
  getState: () => INITIAL,
  getDoc: () => docFromTimeline(INITIAL),
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => 'project-1',
};
const apiChoice = {
  id: 'openai:gpt-5',
  backend: 'api',
  provider: 'openai',
  providerLabel: 'OpenAI',
  model: 'gpt-5',
  capabilities: resolveModelCapabilities({
    backend: 'api',
    provider: 'openai',
    modelId: 'gpt-5',
  }),
} as const;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const apiFailureModel = new MockLanguageModelV4({
  doStream: [
    {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'premature-success' },
          { type: 'text-delta', id: 'premature-success', delta: 'Removed the clip successfully.' },
          { type: 'text-end', id: 'premature-success' },
          {
            type: 'tool-call',
            toolCallId: 'remove-missing',
            toolName: 'remove_item',
            input: '{"itemId":"missing"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
          },
        ],
      }),
    },
    {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'different-tool-success' },
          { type: 'text-delta', id: 'different-tool-success', delta: 'The operation is now fixed.' },
          { type: 'text-end', id: 'different-tool-success' },
          {
            type: 'tool-call',
            toolCallId: 'read-after-failure',
            toolName: 'read_project',
            input: '{}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
          },
        ],
      }),
    },
    {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'false-success' },
          { type: 'text-delta', id: 'false-success', delta: 'Removed the clip successfully.' },
          { type: 'text-end', id: 'false-success' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage,
          },
        ],
      }),
    },
  ],
});
const apiFailureEvents: AgentEvent[] = [];
const apiFailureResult = await runApiAgent(
  [{ role: 'user', content: 'Remove a missing clip.' }],
  apiContext,
  (event) => apiFailureEvents.push(event),
  apiChoice,
  'Test system prompt.',
  false,
  1_000,
  undefined,
  { model: apiFailureModel },
);
assert.doesNotMatch(
  JSON.stringify(apiFailureResult),
  /Removed the clip successfully|operation is now fixed/,
  'API history must discard assistant text before and after an unresolved tool error',
);
assert.match(String(apiFailureResult.at(-1)?.content), /couldn't complete the requested operation/);
assert.doesNotMatch(
  apiFailureEvents
    .filter((event): event is Extract<AgentEvent, { type: 'text-delta' }> => event.type === 'text-delta')
    .map((event) => event.delta)
    .join(''),
  /Removed the clip successfully|operation is now fixed/,
);

const maxTurnModel = new MockLanguageModelV4({
  doStream: Array.from({ length: 30 }, (_, index) => ({
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: `remove-missing-${index}`,
          toolName: 'remove_item',
          input: '{"itemId":"missing"}',
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage,
        },
      ],
    }),
  })),
});
const maxTurnFailures = new ToolFailureTracker();
const maxTurnEvents: AgentEvent[] = [];
const maxTurnResult = await runApiAgent(
  [{ role: 'user', content: 'Keep removing the missing clip.' }],
  apiContext,
  (event) => maxTurnEvents.push(event),
  apiChoice,
  'Test system prompt.',
  false,
  1_000,
  { toolFailures: maxTurnFailures },
  { model: maxTurnModel },
);
assert.equal(
  maxTurnEvents.some((event) => event.type === 'max-turns'),
  true,
  'repeated failed tools must terminate at the tool-turn limit',
);
assert.match(String(maxTurnResult.at(-1)?.content), /couldn't complete the requested operation/);
assert.equal(maxTurnFailures.hasUnresolved, false, 'max-turn failure reporting must close the tracker');

const abortFailures = new ToolFailureTracker();
abortFailures.record('edit_item', { success: false, result: { error: 'pending failure' } });
const abortController = new AbortController();
abortController.abort();
const abortResult = await runApiAgent(
  [{ role: 'user', content: 'Stop this turn.' }],
  apiContext,
  () => undefined,
  apiChoice,
  'Test system prompt.',
  false,
  1_000,
  { signal: abortController.signal, toolFailures: abortFailures },
  {
    model: new MockLanguageModelV4({
      doStream: async () => {
        throw new DOMException('Stopped', 'AbortError');
      },
    }),
  },
);
assert.equal(abortResult.length, 1);
assert.equal(abortFailures.hasUnresolved, false, 'aborting a turn must discard its failure state');

const toolFailures = new ToolFailureTracker();
toolFailures.record('edit_item', { success: false, result: { error: 'bad item id' } });
toolFailures.record('read_project', { success: true, result: { ok: true } });
assert.equal(toolFailures.hasUnresolved, true, 'another tool cannot erase an edit failure');
assert.match(toolFailures.report(), /edit_item: bad item id/);
toolFailures.record('edit_item', { success: true, result: { ok: true } });
assert.equal(toolFailures.hasUnresolved, false, 'a successful same-tool retry resolves the failure');

toolFailures.record('edit_item', { success: false, result: { error: 'retry failed' } });
toolFailures.record('edit_item', { success: true, result: { denied: true } });
assert.equal(toolFailures.hasUnresolved, true, 'a denied retry cannot resolve an earlier failure');
const persistedFailures = toolFailures.snapshot();
const restoredFailures = new ToolFailureTracker();
restoredFailures.restore(persistedFailures);
assert.match(restoredFailures.report(), /edit_item: retry failed/);
restoredFailures.clear();
assert.equal(restoredFailures.hasUnresolved, false);
console.log('ai-sdk checks passed');
