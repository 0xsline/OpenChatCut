import assert from 'node:assert/strict';
import { createGenerationJob, getGenerationJobSnapshot } from './vite-generation-jobs.ts';
import { pickMurekaAudioUrl } from './vite-plugin-music.ts';

const success = createGenerationJob({ kind: 'music' }, async (jobId) => ({
  assetId: jobId,
  kind: 'audio',
  name: 'check music',
  path: '/media/uploads/check.mp3',
  durationSeconds: 1,
}));
assert.equal(getGenerationJobSnapshot(success.jobId)?.status, 'queued');

await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
const completed = getGenerationJobSnapshot(success.jobId);
assert.equal(completed?.status, 'succeeded');
assert.equal(completed?.result?.assetId, success.jobId);

const failure = createGenerationJob({ kind: 'video' }, async () => { throw new Error('expected failure'); });
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(failure.jobId)?.status, 'failed');
assert.equal(getGenerationJobSnapshot(failure.jobId)?.error, 'expected failure');

assert.equal(pickMurekaAudioUrl({ choices: [{ audio_url: 'audio' }] }), 'audio');
assert.equal(pickMurekaAudioUrl({ choices: [{ url: 'url' }] }), 'url');
assert.equal(pickMurekaAudioUrl({ choices: [{ wav_url: 'wav' }] }), 'wav');
assert.equal(pickMurekaAudioUrl({ choices: [{ flac_url: 'flac' }] }), 'flac');

console.log('generation checks passed');
