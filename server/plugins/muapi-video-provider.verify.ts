import assert from 'node:assert/strict';
import { generateMuAPIVideo, MuAPIUnconfirmedTaskError } from './muapi-video-provider.ts';
import { validateVideoRequest } from './video-validation.ts';

const input = validateVideoRequest({
  model: 'muapi',
  prompt: 'a paper airplane gliding through a sunlit room',
  durationSeconds: 8,
  ratio: '9:16',
  resolution: '720p',
});
const options = {
  muapiBaseUrl: 'https://api.muapi.invalid/api/v1',
  muapiApiKey: 'test-key',
  muapiVideoEndpoint: 'seedance-lite-t2v',
  muapiResolution: '720p',
  pollIntervalMs: 0,
  timeoutMs: 2_000,
};
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method?: string; headers?: HeadersInit; body?: string }> = [];
let responses: Response[] = [];
globalThis.fetch = async (url, init) => {
  calls.push({
    url: String(url),
    method: init?.method,
    headers: init?.headers,
    body: typeof init?.body === 'string' ? init.body : undefined,
  });
  const response = responses.shift();
  if (!response) throw new Error('unexpected fetch');
  return response;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

try {
  await assert.rejects(
    generateMuAPIVideo(input, { ...options, muapiApiKey: '' }, async () => {}),
    /MUAPI_API_KEY/,
  );
  assert.equal(calls.length, 0, 'missing credentials must fail before a paid request');

  const registered: string[] = [];
  const register = async (_provider: string, id: string) => { registered.push(id); };
  calls.length = 0;
  responses = [
    json({ request_id: 'task-1', status: 'processing' }),
    json({ id: 'task-1', status: 'completed', outputs: ['https://cdn.muapi.invalid/task-1.mp4'] }),
  ];
  assert.equal(
    await generateMuAPIVideo(input, options, register),
    'https://cdn.muapi.invalid/task-1.mp4',
  );
  assert.deepEqual(registered, ['task-1']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.muapi.invalid/api/v1/seedance-lite-t2v');
  assert.equal(calls[0].method, 'POST');
  assert.equal(new Headers(calls[0].headers).get('x-api-key'), 'test-key');
  assert.deepEqual(JSON.parse(calls[0].body ?? ''), {
    prompt: input.prompt,
    aspect_ratio: '9:16',
    resolution: '720p',
    duration: 8,
  });
  assert.equal(calls[1].url, 'https://api.muapi.invalid/api/v1/predictions/task-1/result');

  calls.length = 0;
  responses = [
    json({ status: 'completed', outputs: [{ video_url: 'https://cdn.muapi.invalid/resumed.mp4' }] }),
  ];
  assert.equal(
    await generateMuAPIVideo(input, options, register, 'saved/task'),
    'https://cdn.muapi.invalid/resumed.mp4',
  );
  assert.equal(calls.length, 1, 'resume polls the known task without another submission');
  assert.equal(calls[0].url, 'https://api.muapi.invalid/api/v1/predictions/saved%2Ftask/result');
  assert.deepEqual(registered, ['task-1']);

  calls.length = 0;
  responses = [
    json({ request_id: 'task-missing-output' }),
    json({ status: 'completed', outputs: [] }),
  ];
  await assert.rejects(
    generateMuAPIVideo(input, options, register),
    /completed without a video URL/,
  );
  assert.equal(calls.length, 2, 'missing output is observed after one submission and one poll');

  calls.length = 0;
  responses = [json({ status: 'completed' })];
  await assert.rejects(
    generateMuAPIVideo(input, options, register, 'known-task'),
    /completed without a video URL/,
  );
  assert.equal(calls.length, 1);

  calls.length = 0;
  responses = [json({ status: 'processing' }), json({ status: 'completed', outputs: ['https://cdn.muapi.invalid/retry.mp4'] })];
  assert.equal(await generateMuAPIVideo(input, options, register, 'retry-task'), 'https://cdn.muapi.invalid/retry.mp4');
  assert.equal(calls.length, 2, 'the same task id is polled until completion');

  calls.length = 0;
  responses = [json({ status: 'processing' }, 503)];
  await assert.rejects(
    generateMuAPIVideo(input, { ...options, timeoutMs: 1_000 }, register, 'server-error-task'),
    /timed out|HTTP 503/,
  );
  assert.ok(calls.length >= 1, 'transient poll failure does not create a second task');

  calls.length = 0;
  responses = [json({ status: 'processing' }, 500)];
  await assert.rejects(
    generateMuAPIVideo(input, options, register),
    MuAPIUnconfirmedTaskError,
  );
  assert.equal(calls.length, 1, 'a server error on POST is never retried');
  assert.equal(registered.includes(''), false);

  calls.length = 0;
  responses = [json({ status: 'processing' })];
  await assert.rejects(
    generateMuAPIVideo(input, options, register),
    MuAPIUnconfirmedTaskError,
  );
  assert.equal(calls.length, 1, 'a successful submission with no id is classified as ambiguous');
  assert.equal(registered.includes(''), false);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('muapi-video-provider.verify: submit, poll, resume, retry, and paid-task safety passed');
