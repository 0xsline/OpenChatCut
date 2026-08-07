import assert from 'node:assert/strict';
import { personFromSubject, segmentBoundaries } from './visual-geometry';
import { geometrySampleTimes } from './sample';
import {
  __setMediaPipeRuntimeLoaderForVerification,
  GEOM_MAX_FRAMES,
  getMediaPipeRuntime,
} from './mediapipe';
import type { MediaPipeRuntime } from './mediapipe';

async function main(): Promise<void> {
  // 1. Scene boundaries from sampled frames (sceneStart/sceneEnd) are used.
  const frames = [
    { sampleTime: 0.5, sceneStart: 0, sceneEnd: 10 },
    { sampleTime: 3, sceneStart: 0, sceneEnd: 10 },
    { sampleTime: 12, sceneStart: 10, sceneEnd: 20 },
  ];
  const scenes = segmentBoundaries(frames, 20);
  assert.deepEqual(scenes, [
    { startSec: 0, endSec: 10 },
    { startSec: 10, endSec: 20 },
  ]);

  // 2. Sub-minimum scenes are dropped.
  const short = [
    { sampleTime: 0.1, sceneStart: 0, sceneEnd: 0.2 },
    { sampleTime: 5, sceneStart: 0, sceneEnd: 10 },
  ];
  const kept = segmentBoundaries(short, 10);
  assert.deepEqual(kept, [{ startSec: 0, endSec: 10 }]);

  // 3. No scene metadata → uniform buckets covering the full span.
  const plain = [{ sampleTime: 1 }, { sampleTime: 5 }];
  const buckets = segmentBoundaries(plain, 12);
  assert.ok(buckets.length >= 2, 'buckets cover the span');
  assert.equal(buckets[0]!.startSec, 0);
  assert.equal(buckets[buckets.length - 1]!.endSec, 12);

  // 4. personFromSubject side detection.
  assert.equal(personFromSubject({ x: 0.1, y: 0.2, w: 0.1, h: 0.3 }), 'left');
  assert.equal(personFromSubject({ x: 0.45, y: 0.2, w: 0.1, h: 0.3 }), 'center');
  assert.equal(personFromSubject({ x: 0.7, y: 0.2, w: 0.1, h: 0.3 }), 'right');
  assert.equal(personFromSubject(null), 'none');
  assert.equal(personFromSubject({ x: 0.1, y: 0.2, w: 0.01, h: 0.01 }), 'none', 'tiny bbox is not a person');

  // 5. Sampling includes both endpoints without exceeding the hard cap.
  const capped = geometrySampleTimes(600);
  assert.equal(capped.length, GEOM_MAX_FRAMES);
  assert.equal(capped[0], 0);
  assert.equal(capped[capped.length - 1], 600);
  const tinyBudget = geometrySampleTimes(60, 4);
  assert.equal(tinyBudget.length, 4);
  assert.equal(tinyBudget[0], 0);
  assert.equal(tinyBudget[tinyBudget.length - 1], 60);

  // 6. Aborting a stalled lazy initializer retires it, allowing a clean retry.
  let attempts = 0;
  let resolveStalled!: (runtime: MediaPipeRuntime | null) => void;
  let stalledLoadSignal: AbortSignal | null = null;
  const observedLoadSignal = (): AbortSignal | null => stalledLoadSignal;
  let staleCloseCount = 0;
  const staleRuntime: MediaPipeRuntime = {
    delegate: 'CPU',
    segment: () => ({ face: null, occ: new Uint8Array() }),
    close: () => { staleCloseCount += 1; },
  };
  const retryRuntime: MediaPipeRuntime = {
    delegate: 'CPU',
    segment: () => ({ face: null, occ: new Uint8Array() }),
    close: () => undefined,
  };
  __setMediaPipeRuntimeLoaderForVerification((loadSignal) => {
    attempts += 1;
    if (attempts === 1) {
      stalledLoadSignal = loadSignal;
      return new Promise((resolve) => { resolveStalled = resolve; });
    }
    return Promise.resolve(retryRuntime);
  });
  try {
    const controller = new AbortController();
    const stalled = getMediaPipeRuntime(controller.signal);
    const timeout = new Error('geometry analysis timeout');
    controller.abort(timeout);
    await assert.rejects(stalled, (error) => error === timeout);
    assert.equal(observedLoadSignal()?.aborted, true, 'timeout aborts the initializer');

    assert.equal(await getMediaPipeRuntime(), retryRuntime);
    assert.equal(attempts, 2, 'a timed-out initializer does not poison retries');

    resolveStalled(staleRuntime);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.equal(staleCloseCount, 1, 'a late stale runtime is closed');
    assert.equal(await getMediaPipeRuntime(), retryRuntime);
  } finally {
    __setMediaPipeRuntimeLoaderForVerification(null);
  }

  console.log('visual-geometry.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
