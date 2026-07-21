import assert from 'node:assert/strict';
import { TaskLimiter } from '../task-limiter.ts';
import { createGenerationJob, deleteGenerationJob, getGenerationJobSnapshot } from './generation-jobs.ts';
import { pickMurekaAudioUrl } from './music.ts';

const success = createGenerationJob({ kind: 'music' }, async (jobId, update) => {
  update({ phase: 'rendering', progress: 63, processedFrames: 63, totalFrames: 100 });
  const running = getGenerationJobSnapshot(jobId);
  assert.equal(running?.status, 'running');
  assert.equal(running?.phase, 'rendering');
  assert.equal(running?.progress, 63);
  assert.equal(running?.processedFrames, 63);
  assert.equal(running?.totalFrames, 100);
  return {
    assetId: jobId,
    kind: 'audio',
    name: 'check music',
    path: '/media/uploads/check.mp3',
    durationSeconds: 1,
  };
});
assert.equal(getGenerationJobSnapshot(success.jobId)?.status, 'queued');

await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
const completed = getGenerationJobSnapshot(success.jobId);
assert.equal(completed?.status, 'succeeded');
assert.equal(completed?.phase, 'completed');
assert.equal(completed?.progress, 100);
assert.equal(completed?.processedFrames, 100);
assert.equal(completed?.result?.assetId, success.jobId);

const cleanedPaths: string[] = [];
const cleanupResult = (id: string) => ({
  assetId: id,
  kind: 'video' as const,
  name: id,
  path: `/media/uploads/${id}.mp4`,
  durationSeconds: 1,
});
const removable = createGenerationJob({ kind: 'export' }, async (id) => cleanupResult(id), {
  cleanupResult: async (generated) => { cleanedPaths.push(generated.path); },
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(await deleteGenerationJob(removable.jobId), true);
assert.equal(getGenerationJobSnapshot(removable.jobId), undefined);
assert.deepEqual(cleanedPaths, [`/media/uploads/${removable.jobId}.mp4`]);
assert.equal(await deleteGenerationJob(removable.jobId), false, 'job cleanup must be idempotent');

const expiring = createGenerationJob({ kind: 'export' }, async (id) => cleanupResult(id), {
  cleanupResult: async (generated) => { cleanedPaths.push(`expired:${generated.path}`); },
  retentionMs: 10,
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
assert.equal(getGenerationJobSnapshot(expiring.jobId), undefined, 'expired jobs must be evicted automatically');
assert.ok(cleanedPaths.includes(`expired:/media/uploads/${expiring.jobId}.mp4`), 'expiry must dispose the result file');

const failure = createGenerationJob({ kind: 'video' }, async () => { throw new Error('expected failure'); });
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(failure.jobId)?.status, 'failed');
assert.equal(getGenerationJobSnapshot(failure.jobId)?.phase, 'failed');
assert.equal(getGenerationJobSnapshot(failure.jobId)?.error, 'expected failure');

const limiter = new TaskLimiter(1);
let finishFirst: (() => void) | undefined;
const firstBlocked = new Promise<void>((resolve) => { finishFirst = resolve; });
const result = (id: string) => ({
  assetId: id,
  kind: 'video' as const,
  name: id,
  path: `/media/uploads/${id}.mp4`,
  durationSeconds: 1,
});
const first = createGenerationJob({ kind: 'export' }, async (id) => {
  await firstBlocked;
  return result(id);
}, { acquire: () => limiter.acquire() });
const second = createGenerationJob({ kind: 'export' }, async (id) => result(id), {
  acquire: () => limiter.acquire(),
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(first.jobId)?.status, 'running');
assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'queued');
assert.deepEqual(limiter.snapshot(), { active: 1, queued: 1, limit: 1 });
const realNow = Date.now;
Date.now = () => realNow() + 2 * 60 * 60_000;
createGenerationJob({ kind: 'cleanup-trigger' }, async (id) => result(id));
Date.now = realNow;
assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'queued', 'age cleanup must retain queued jobs');
finishFirst?.();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(first.jobId)?.status, 'succeeded');
assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'succeeded');
assert.deepEqual(limiter.snapshot(), { active: 0, queued: 0, limit: 1 });

assert.equal(pickMurekaAudioUrl({ choices: [{ audio_url: 'audio' }] }), 'audio');
assert.equal(pickMurekaAudioUrl({ choices: [{ url: 'url' }] }), 'url');
assert.equal(pickMurekaAudioUrl({ choices: [{ wav_url: 'wav' }] }), 'wav');
assert.equal(pickMurekaAudioUrl({ choices: [{ flac_url: 'flac' }] }), 'flac');

console.log('generation checks passed');
