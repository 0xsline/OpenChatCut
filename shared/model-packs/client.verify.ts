import assert from 'node:assert/strict';
import {
  cancelModelPackInstall,
  deleteModelPack,
  installModelPack,
} from './client';

interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

const calls: FetchCall[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  calls.push({ input, init });
  const body = String(input).endsWith('/download')
    ? {
        task: {
          id: 'rhythm-lite',
          status: 'downloading',
          bytesDone: 0,
          bytesTotal: 1,
          filesDone: 0,
          filesTotal: 1,
        },
      }
    : { ok: true };
  return new Response(JSON.stringify(body), {
    status: String(input).endsWith('/download') ? 202 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

try {
  const credentialHeaders = new Headers({
    'Content-Type': 'text/plain',
    'X-OpenChatCut-Editor-Credential': 'editor-secret',
  });
  await installModelPack('rhythm-lite', credentialHeaders);
  await cancelModelPackInstall('rhythm-lite', credentialHeaders);
  await deleteModelPack('rhythm-lite', credentialHeaders);

  assert.deepEqual(calls.map((call) => String(call.input)), [
    '/api/model-packs/download',
    '/api/model-packs/cancel',
    '/api/model-packs/delete',
  ]);
  for (const call of calls) {
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.body, JSON.stringify({ id: 'rhythm-lite' }));
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-openchatcut-editor-credential'), 'editor-secret');
  }
  assert.equal(credentialHeaders.get('content-type'), 'text/plain', 'the caller-owned headers must not be mutated');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('model-packs-client.verify: mutation credentials forwarded');
