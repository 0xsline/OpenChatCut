import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { generateText, jsonSchema, streamText, tool, wrapLanguageModel } from 'ai';
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from 'ai/test';
import {
  createServerLanguageModel,
  serverProviderOptions,
  toolCallFinishReasonMiddleware,
} from './model';
import { getLanguageModel, getLanguageModelProviderOptions } from '../../src/agent/client';
import { LLM_PROVIDER_PRESETS } from '../../shared/llm-providers';

for (const preset of LLM_PROVIDER_PRESETS) {
  for (const apiMode of ['chat', 'responses'] as const) {
    assert.equal(
      createServerLanguageModel(preset.id, 'test-model', apiMode, 'http://127.0.0.1:49999').provider,
      (await getLanguageModel(preset.id, 'test-model', apiMode)).provider,
      `${preset.id}: browser and server must select the same request protocol`,
    );
    for (const cacheMode of ['short', 'long'] as const) {
      assert.deepEqual(
        serverProviderOptions(preset.id, apiMode, cacheMode),
        getLanguageModelProviderOptions(preset.id, apiMode, cacheMode),
        `${preset.id}: browser and server must share provider request options`,
      );
    }
  }
}

let originHeader: string | undefined;
let fetchSiteHeader: string | undefined;
const server = createServer((req, res) => {
  originHeader = req.headers.origin;
  fetchSiteHeader = req.headers['sec-fetch-site'];
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"captured"}}');
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await assert.rejects(generateText({
    model: createServerLanguageModel('deepseek', 'test-model', 'chat', origin),
    prompt: 'test',
    maxRetries: 0,
  }));
  assert.equal(originHeader, origin);
  assert.equal(fetchSiteHeader, 'same-origin');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('agent-runs/model.verify: internal proxy request passes the origin gate');

// The AI SDK runs a step's tools only when it finishes with `stop` or `tool-calls`.
// A gateway that ends a tool turn with a non-standard finish_reason surfaces as
// `other`; only client tool calls relabel it, so provider-run tools and plain text
// keep the provider's reason.
{
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const finish = { type: 'finish', finishReason: { unified: 'other', raw: 'tool_use' }, usage } as const;
  const finishReasonOf = async (parts: LanguageModelV4StreamPart[]) => {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
      }),
      middleware: toolCallFinishReasonMiddleware,
    });
    const streamed = await convertReadableStreamToArray((await model.doStream({ prompt: [] })).stream);
    const last = streamed.at(-1);
    assert(last?.type === 'finish');
    return last.finishReason;
  };
  const call = { type: 'tool-call', toolCallId: 'call-1', toolName: 'probe', input: '{}' } as const;
  assert.deepEqual(await finishReasonOf([call, finish]), { unified: 'tool-calls', raw: 'tool_use' });
  assert.deepEqual(await finishReasonOf([{ ...call, providerExecuted: true }, finish]), finish.finishReason);
  assert.deepEqual(await finishReasonOf([finish]), finish.finishReason);
}

// End to end through the real server model and OpenAI-compatible parser: a gateway
// answering a tool call with finish_reason "tool_use" still gets the tool run, streamed
// or not, while a `length` cutoff keeps the SDK's refusal to run a truncated turn.
let gatewayFinishReason = 'tool_use';
const toolCallMessage = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
};
const gateway = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const base = { id: 'gateway-1', created: 1, model: 'gateway-model' };
    if (!(JSON.parse(body) as { stream?: boolean }).stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [{ index: 0, message: toolCallMessage, finish_reason: gatewayFinishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    const chunk = (delta: unknown, finishReason: string | null) => `data: ${JSON.stringify({
      ...base,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
    const [toolCall] = toolCallMessage.tool_calls;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, ...toolCall }] }, null)
        + chunk({}, gatewayFinishReason)
        + 'data: [DONE]\n\n',
    );
  });
});
const listen = (target: Server) => new Promise<void>((resolve, reject) => {
  target.once('error', reject);
  target.listen(0, '127.0.0.1', resolve);
});
await listen(gateway);
try {
  const address = gateway.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [raw, expected] of [
    ['tool_use', { executed: 1, finishReason: 'tool-calls' }],
    ['length', { executed: 0, finishReason: 'length' }],
  ] as const) {
    gatewayFinishReason = raw;
    let executed = 0;
    const tools = {
      probe: tool({
        inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
        execute: async () => {
          executed += 1;
          return 'ok';
        },
      }),
    };
    const streamed = streamText({
      model: createServerLanguageModel('ollama', 'gateway-model', 'chat', origin),
      prompt: 'go',
      tools,
      maxRetries: 0,
    });
    await streamed.consumeStream();
    assert.deepEqual({ executed, finishReason: await streamed.finishReason }, expected, `streamed ${raw}`);
    executed = 0;
    const generated = await generateText({
      model: createServerLanguageModel('ollama', 'gateway-model', 'chat', origin),
      prompt: 'go',
      tools,
      maxRetries: 0,
    });
    assert.deepEqual({ executed, finishReason: generated.finishReason }, expected, `generated ${raw}`);
  }
} finally {
  await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
}

console.log('agent-runs/model.verify: tool calls behind a non-standard finish reason still run');
