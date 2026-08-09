import assert from 'node:assert/strict';
import { mutateLocalAsrModel } from './local-asr-model-mutation';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    openChatCutDesktop: {
      editorCredentials: async () => ({ credential: 'asr-editor-secret', mcpToken: 'unused' }),
    },
  },
});
globalThis.fetch = async (input, init) => {
  calls.push({ input, init });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await mutateLocalAsrModel('download', 'whisper-tiny');
  await mutateLocalAsrModel('delete', 'whisper-tiny');
  assert.deepEqual(calls.map((call) => String(call.input)), [
    '/api/asr-models/download',
    '/api/asr-models/delete',
  ]);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.body, JSON.stringify({ id: 'whisper-tiny' }));
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-openchatcut-editor-credential'), 'asr-editor-secret');
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

console.log('local-asr-model-mutation.verify: renderer credential forwarded');
