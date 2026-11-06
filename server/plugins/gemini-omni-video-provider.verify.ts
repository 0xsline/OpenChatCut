import assert from 'node:assert/strict';
import {
  buildOmniVideoRequestBodySync,
  extractOmniVideo,
  omniAspectRatio,
  omniDuration,
  omniFileId,
  omniResolution,
  omniTask,
} from './gemini-omni-video-helpers.ts';
import { generateGeminiOmniVideo, geminiOmniResultFetch } from './gemini-omni-video-provider.ts';
import { validateVideoRequest } from './video-validation.ts';

assert.equal(omniAspectRatio('9:16'), '9:16');
assert.equal(omniAspectRatio('16:9'), '16:9');
assert.equal(omniAspectRatio('1:1'), '16:9');

assert.equal(omniResolution(undefined), '720p');
assert.equal(omniResolution('1080p'), '1080p');
assert.equal(omniResolution('480p'), '720p');

assert.equal(omniTask({ firstFramePath: undefined, lastFramePath: undefined, refImagePaths: [] }), undefined);
assert.equal(omniTask({ firstFramePath: '/media/uploads/a.jpg', lastFramePath: undefined, refImagePaths: [] }), 'image_to_video');
assert.equal(omniTask({ firstFramePath: undefined, lastFramePath: undefined, refImagePaths: ['/media/uploads/a.jpg'] }), 'reference_to_video');
assert.equal(
  omniTask({ firstFramePath: '/media/uploads/a.jpg', lastFramePath: '/media/uploads/b.jpg', refImagePaths: [] }),
  undefined,
);

// Duration is the API's native response_format.duration, not a prompt hint.
assert.equal(omniDuration(8, true), '8s');
assert.equal(omniDuration(5, false), undefined);
const timed = buildOmniVideoRequestBodySync('m', {
  prompt: ' A cat jumps ', durationSeconds: 8, durationSpecified: true, ratio: '16:9', refImagePaths: [],
}, []);
assert.equal(timed.input, 'A cat jumps');
assert.equal(timed.response_format.duration, '8s');
assert.equal(timed.response_format.delivery, 'uri');
const untimed = buildOmniVideoRequestBodySync('m', {
  prompt: 'A cat jumps', durationSeconds: 5, durationSpecified: false, ratio: '16:9', refImagePaths: [],
}, []);
assert.equal('duration' in untimed.response_format, false, 'unset duration leaves the 10s API default');

assert.equal(omniFileId('files/abc-123'), 'abc-123');
assert.equal(omniFileId('https://generativelanguage.googleapis.com/v1beta/files/xyz_9:download?alt=media'), 'xyz_9');
assert.equal(omniFileId('https://generativelanguage.googleapis.com/download/v1beta/files/q1:download?alt=media'), 'q1');
assert.equal(omniFileId('https://example.test/v.mp4'), undefined);
assert.equal(omniFileId('https://storage.example/bucket/files/abc'), undefined);

const fromConvenience = extractOmniVideo({
  output_video: { data: 'AAAA', mime_type: 'video/mp4' },
});
assert.equal(fromConvenience.data, 'AAAA');

const fromSteps = extractOmniVideo({
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
    {
      type: 'model_output',
      content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://example.test/v.mp4' }],
    },
  ],
});
assert.equal(fromSteps.uri, 'https://example.test/v.mp4');
assert.equal(extractOmniVideo({}).data, undefined);

const t2v = validateVideoRequest({
  model: 'gemini-omni', prompt: 'marble track', durationSeconds: 6, ratio: '16:9',
});
assert.equal(t2v.model, 'gemini-omni');
assert.equal(t2v.ratio, '16:9');

const i2v = validateVideoRequest({
  model: 'gemini-omni',
  prompt: 'animate still',
  firstFramePath: '/media/uploads/a.jpg',
  resolution: '1080p',
});
assert.equal(i2v.firstFramePath, '/media/uploads/a.jpg');
assert.equal(i2v.resolution, '1080p');

assert.throws(
  () => validateVideoRequest({ model: 'gemini-omni', prompt: 'x', ratio: '1:1' }),
  /16:9 or 9:16/,
);
assert.throws(
  () => validateVideoRequest({
    model: 'gemini-omni',
    prompt: 'x',
    firstFramePath: '/media/uploads/a.jpg',
    refImagePaths: ['/media/uploads/b.jpg'],
  }),
  /cannot be combined with refImages/,
);
assert.throws(
  () => validateVideoRequest({
    model: 'gemini-omni',
    prompt: 'x',
    refVideoPaths: ['/media/uploads/v.mp4'],
  }),
  /refVideos\/refAudios/,
);

for (const durationSeconds of [3, 15]) {
  assert.equal(validateVideoRequest({ model: 'gemini-omni', prompt: 'x', durationSeconds }).durationSeconds, durationSeconds);
}
for (const durationSeconds of [2, 16]) {
  assert.throws(() => validateVideoRequest({ model: 'gemini-omni', prompt: 'x', durationSeconds }), /between 3 and 15/);
}
const frames = { firstFramePath: '/media/uploads/a.jpg', lastFramePath: '/media/uploads/b.jpg' };
assert.equal(validateVideoRequest({ model: 'gemini-omni', prompt: 'x', durationSeconds: 10, ...frames }).durationSeconds, 10);
assert.throws(
  () => validateVideoRequest({ model: 'gemini-omni', prompt: 'x', durationSeconds: 11, ...frames }),
  /3 to 10/,
);
const refs = (count: number) => Array.from({ length: count }, (_, index) => `/media/uploads/r${index}.jpg`);
assert.equal(validateVideoRequest({ model: 'gemini-omni', prompt: 'x', refImagePaths: refs(6) }).refImagePaths.length, 6);
assert.throws(() => validateVideoRequest({ model: 'gemini-omni', prompt: 'x', refImagePaths: refs(7) }), /at most 6/);

// Provider flow against a stubbed Gemini API: URI delivery → poll the file → keyed download URL.
type Call = { url: string; method: string; headers: Record<string, string>; body?: string; redirect?: string };
const calls: Call[] = [];
let fileState = 'ACTIVE';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const headers = { ...(init?.headers as Record<string, string> | undefined) };
  calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body as string | undefined, redirect: init?.redirect });
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (url === 'https://gemini.test/v1beta/interactions') return json({ id: 'int-1', output_video: { uri: 'files/abc-123' } });
  if (url === 'https://gemini.test/v1beta/files/abc-123') {
    return json(fileState === 'FAILED' ? { state: 'FAILED', error: { message: 'video blocked' } } : { state: fileState });
  }
  if (url === 'https://gemini.test/v1beta/files/abc-123:download?alt=media') {
    return new Response(null, { status: 302, headers: { location: 'https://storage.example/video.mp4' } });
  }
  if (url === 'https://storage.example/video.mp4') return new Response('mp4', { headers: { 'content-type': 'video/mp4' } });
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;
try {
  const options = { geminiBaseUrl: 'https://gemini.test/', geminiApiKey: 'test-key', geminiOmniVideoModel: '' };
  const input = validateVideoRequest({ model: 'gemini-omni', prompt: 'neon city', durationSeconds: 8 });
  const registered: string[] = [];
  const register = async (provider: string, taskId: string) => { registered.push(`${provider}:${taskId}`); };
  const downloadUrl = 'https://gemini.test/v1beta/files/abc-123:download?alt=media';

  assert.equal(await generateGeminiOmniVideo(input, options, register), downloadUrl);
  assert.deepEqual(registered, ['gemini-omni:file:abc-123']);
  const post = calls.find((call) => call.method === 'POST')!;
  assert.equal(post.headers['x-goog-api-key'], 'test-key');
  const sent = JSON.parse(post.body!) as { model: string; response_format: { duration?: string } };
  assert.equal(sent.model, 'gemini-omni-1.2-flash');
  assert.equal(sent.response_format.duration, '8s');
  assert.equal(calls.find((call) => call.url.endsWith('/files/abc-123'))?.headers['x-goog-api-key'], 'test-key');

  calls.length = 0;
  assert.equal(await generateGeminiOmniVideo(input, options, register, 'file:abc-123'), downloadUrl);
  assert.equal(calls.some((call) => call.method === 'POST'), false, 'resume polls the file without re-billing');
  await assert.rejects(generateGeminiOmniVideo(input, options, register, 'int-1'), /cannot resume/);

  fileState = 'FAILED';
  await assert.rejects(generateGeminiOmniVideo(input, options, register, 'file:abc-123'), /video blocked/);

  calls.length = 0;
  const response = await geminiOmniResultFetch(options)(downloadUrl, { signal: new AbortController().signal });
  assert.equal(await response.text(), 'mp4');
  assert.deepEqual(calls.map((call) => [call.url, call.headers['x-goog-api-key'], call.redirect]), [
    [downloadUrl, 'test-key', 'manual'],
    ['https://storage.example/video.mp4', undefined, 'manual'],
  ], 'the key goes to the Gemini origin only, never to the redirect target');
} finally {
  globalThis.fetch = realFetch;
}

console.log('gemini-omni-video-provider.verify: ok');
