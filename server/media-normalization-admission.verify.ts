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

// Rotation-coded portrait footage (issue report: 9:16 assets recognized as
// 16:9). Coded 1920x1080 + rotation 90/270 must swap to 1080x1920; the
// rotation comes from side-data, top-level field, or stream tags.
{
  const { rotationOf, displayDimensions } = await import('./media-normalization');
  assert.deepEqual(displayDimensions(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions(1920, 1080, 270), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions(1920, 1080, 0), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions(1920, 1080, 180), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions(1080, 1920, 0), { width: 1080, height: 1920 });
  assert.equal(rotationOf({ side_data_list: [{ rotation: -90 }] }), 270);
  assert.equal(rotationOf({ rotation: 90 }), 90);
  assert.equal(rotationOf({ tags: { rotate: '270' } }), 270);
  assert.equal(rotationOf({}), 0);
}
