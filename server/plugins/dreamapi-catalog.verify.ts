import assert from 'node:assert/strict';
import { buildDreamApiCall, DREAMAPI_MODELS, DREAMAPI_MODEL_IDS } from '../../shared/dreamapi-models.ts';
import { DREAMAPI_BASE_URL, runDreamApi } from './dreamapi-provider.ts';

assert.equal(new Set(DREAMAPI_MODEL_IDS).size, DREAMAPI_MODELS.length, 'DreamAPI model ids are unique');
assert.ok(DREAMAPI_MODELS.length >= 36, 'catalog includes the DreamAPI skill models');
assert.ok(DREAMAPI_MODELS.every((model) => model.label.startsWith('DreamAPI ·')), 'every model is labeled DreamAPI');
assert.ok(DREAMAPI_MODELS.every((model) => model.endpoint.startsWith('/api/')), 'endpoints stay on the DreamAPI path prefix');

assert.throws(() => buildDreamApiCall('missing', {}), /Choose a DreamAPI model/);
assert.throws(() => buildDreamApiCall('dreamvideo-3-text', { prompt: 'a', duration: 2 }), /duration must be at least 3/);
assert.throws(() => buildDreamApiCall('dreamimage-2', { prompt: 'edit' }), /image is required/);
assert.throws(() => buildDreamApiCall('lipsync', { srcVideo: 'https://example.com/a.mp4' }), /audio is required/);
assert.throws(() => buildDreamApiCall('video-translate-2', { video: 'https://example.com/a.mp4', sourceLanguage: 'fr', targetLanguage: 'zh' }), /sourceLanguage/);
assert.throws(() => buildDreamApiCall('try-on', { modelImage: 'https://example.com/m.png' }), /upper, lower, or overall/);
assert.throws(() => buildDreamApiCall('seedream', { prompt: 'cat', seedreamModel: 'seedream-4.5', size: '1024x1024' }), /pixel range/);
assert.throws(() => buildDreamApiCall('flux-text', { prompt: 'cat', width: 100 }), /multiple of 16/);
assert.throws(() => buildDreamApiCall('lipsync', { srcVideo: 'https://example.com/a.mp4', audio: 'https://example.com/a.mp3', prompt: 'no' }), /prompt is not supported/);

const lipsync = buildDreamApiCall('lipsync-2', {
  srcVideo: 'https://example.com/a.mp4', audio: 'https://example.com/a.mp3', vocalAudio: 'https://example.com/v.mp3',
});
assert.equal(lipsync.body.vocalAudioUrl, 'https://example.com/v.mp3');
assert.equal((lipsync.body.videoParams as { video_enhance: number }).video_enhance, 1);

let submitCount = 0;
const fetchImpl: typeof fetch = async (url, init) => {
  const href = String(url);
  const body = JSON.parse(String(init?.body ?? '{}')) as { taskId?: string };
  if (href === `${DREAMAPI_BASE_URL}/api/getAsyncResult`) {
    return Response.json({ code: 0, data: { task: { status: 3, taskId: body.taskId }, videos: [{ videoUrl: 'https://cdn.example/out.mp4' }] } });
  }
  submitCount += 1;
  return Response.json({ code: 0, data: { taskId: 'task-1' } });
};

const resumed = await runDreamApi(
  buildDreamApiCall('wan-2.1-text', { prompt: 'city' }),
  { apiKey: 'test-key', fetchImpl, existingTaskId: 'dreamapi:task-1', pollIntervalMs: 0 },
);
assert.equal(submitCount, 0, 'resuming a stored task does not submit another paid request');
assert.deepEqual(resumed.urls, ['https://cdn.example/out.mp4']);

const fresh = await runDreamApi(
  buildDreamApiCall('wan-2.1-text', { prompt: 'city' }),
  { apiKey: 'test-key', fetchImpl, pollIntervalMs: 0 },
);
assert.equal(submitCount, 1);
assert.equal(fresh.taskId, 'task-1');

console.log('dreamapi catalog ok');
