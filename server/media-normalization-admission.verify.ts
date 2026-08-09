import assert from 'node:assert/strict';
import {
  createNormalizeAdmission,
  normalizationAbortError,
} from './media-normalization-admission.ts';

const admission = createNormalizeAdmission(1, 2);
const releaseActive = await admission.acquire('/media/one.mp4');
const abort = new AbortController();
const queued = admission.acquire('/media/one.mp4', abort.signal);
assert.deepEqual(admission.snapshot(), { active: 1, queued: 1 });
abort.abort(new DOMException('watch stopped', 'AbortError'));
await assert.rejects(queued, /watch stopped/);
assert.deepEqual(
  admission.snapshot(),
  { active: 1, queued: 0 },
  'an aborted queued normalization must leave no latent admission waiter',
);
releaseActive();
const releaseNext = await admission.acquire('/media/two.mp4');
assert.deepEqual(admission.snapshot(), { active: 1, queued: 0 });
releaseNext();
assert.deepEqual(admission.snapshot(), { active: 0, queued: 0 });

const alreadyAborted = new AbortController();
alreadyAborted.abort();
await assert.rejects(
  admission.acquire('/media/three.mp4', alreadyAborted.signal),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
);
assert.equal(normalizationAbortError(alreadyAborted.signal).name, 'AbortError');

process.stdout.write('media-normalization-admission.verify: abortable queue cleanup passed\n');
