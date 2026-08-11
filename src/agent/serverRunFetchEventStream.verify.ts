import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  FetchServerRunEventStream,
} from './serverRunFetchEventStream.ts';
import { SERVER_RUN_CAPABILITY_HEADER } from './serverRunProtocol.ts';

const encoder = new TextEncoder();
let requestedUrl = '';
let requestedHeaders = new Headers();
const responseBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode('id: 8\r'));
    controller.enqueue(encoder.encode('\nevent: custom\r\ndata: first\r\ndata: second\r\n\r\n'));
    controller.enqueue(encoder.encode('id: 9\nevent: done\ndata: {"status":"completed"}\n\n'));
    controller.close();
  },
});
const capability = 'a'.repeat(43);
const source = new FetchServerRunEventStream({
  projectId: 'project stream',
  runId: '11111111-1111-4111-8111-111111111111',
  capability,
  after: 7,
  fetch: (async function(this: unknown, input, init) {
    assert.equal(this, undefined, 'native fetch must not receive the stream object as this');
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    return new Response(responseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
  }) as typeof fetch,
});
let opened = false;
let transportErrors = 0;
const received: Array<{ type: string; data: string; id: string }> = [];
source.onopen = () => { opened = true; };
source.addEventListener('error', () => { transportErrors += 1; });
source.addEventListener('custom', (event) => {
  const message = event as MessageEvent<string>;
  received.push({ type: event.type, data: message.data, id: message.lastEventId });
});
const terminal = Promise.withResolvers<void>();
source.addEventListener('done', (event) => {
  const message = event as MessageEvent<string>;
  received.push({ type: event.type, data: message.data, id: message.lastEventId });
  terminal.resolve();
});
await terminal.promise;
await delay(0);
assert(opened);
assert.equal(requestedHeaders.get(SERVER_RUN_CAPABILITY_HEADER), capability);
assert.equal(requestedHeaders.get('Last-Event-ID'), '7');
assert(!requestedUrl.includes(capability), 'the bearer capability never appears in the SSE URL');
assert.match(requestedUrl, /projectId=project%20stream&after=7$/);
assert.deepEqual(received, [
  { type: 'custom', data: 'first\nsecond', id: '8' },
  { type: 'done', data: '{"status":"completed"}', id: '9' },
]);
assert.equal(transportErrors, 0, 'terminal EOF does not schedule a reconnect');

let pendingSignal: AbortSignal | undefined;
let aborted = false;
const pendingSource = new FetchServerRunEventStream({
  projectId: 'project-abort',
  runId: '22222222-2222-4222-8222-222222222222',
  capability,
  after: 0,
  fetch: ((_input, init) => {
    pendingSignal = init?.signal ?? undefined;
    const pending = Promise.withResolvers<Response>();
    pendingSignal?.addEventListener('abort', () => {
      aborted = true;
      pending.reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
    return pending.promise;
  }) as typeof fetch,
});
let errorsAfterClose = 0;
pendingSource.addEventListener('error', () => { errorsAfterClose += 1; });
await delay(0);
pendingSource.close();
await delay(0);
assert(pendingSignal?.aborted);
assert(aborted);
assert.equal(errorsAfterClose, 0, 'intentional close suppresses transport errors');

console.log('server run fetch event stream verification passed');
