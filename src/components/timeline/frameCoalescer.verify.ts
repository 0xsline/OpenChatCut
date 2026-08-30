// The timeline's hover preview applies pointer positions through a frame
// coalescer. The browser hands over each pointer report in its own task, so
// applying them directly committed the timeline, the timecode and the preview
// panel once per report — 890 DOM mutations over 60 moves, measured in the
// editor, against 200 once coalesced. What must hold:
//   - many values in one frame collapse to ONE application, of the LAST value
//   - the newest apply callback wins (React closures go stale every render)
//   - cancel() drops the pending frame, so unmount cannot apply into dead state
//   - a throwing apply does not wedge the coalescer for later values
// npx tsx src/components/timeline/frameCoalescer.verify.ts
import assert from 'node:assert/strict';
import { createFrameCoalescer } from './frameCoalescer';

/** A hand-cranked animation frame, so the test never depends on real timing. */
function fakeFrames() {
  const queued = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    schedule: (callback: () => void) => { queued.set(nextHandle, callback); return nextHandle++; },
    cancel: (handle: number) => { queued.delete(handle); },
    get scheduled() { return queued.size; },
    run() {
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback();
    },
  };
}

// ── many reports in one frame collapse to one application of the last value ──
{
  const frames = fakeFrames();
  const applied: number[] = [];
  const coalescer = createFrameCoalescer<number>(frames.schedule, frames.cancel);

  for (const x of [10, 20, 30, 40, 50]) coalescer.schedule(x, (v) => applied.push(v));
  assert.equal(frames.scheduled, 1, 'five reports schedule exactly one frame');
  // Length rather than deepEqual against []: the strict assert types narrow the
  // array to never[] on an empty-literal comparison, breaking every later push.
  assert.equal(applied.length, 0, 'nothing is applied before the frame runs');
  assert.equal(coalescer.pending, true, 'a frame is pending');

  frames.run();
  assert.deepEqual(applied, [50], 'only the newest value is applied');
  assert.equal(coalescer.pending, false, 'the coalescer is idle again');
}

// ── each frame applies its own newest value ─────────────────────────────────
{
  const frames = fakeFrames();
  const applied: number[] = [];
  const coalescer = createFrameCoalescer<number>(frames.schedule, frames.cancel);
  const push = (v: number) => applied.push(v);

  coalescer.schedule(1, push); coalescer.schedule(2, push);
  frames.run();
  coalescer.schedule(3, push); coalescer.schedule(4, push);
  frames.run();
  assert.deepEqual(applied, [2, 4], 'one application per frame, the last value each time');
}

// ── the newest callback wins: a stale React closure must not be used ─────────
{
  const frames = fakeFrames();
  const seen: string[] = [];
  const coalescer = createFrameCoalescer<number>(frames.schedule, frames.cancel);
  coalescer.schedule(1, () => seen.push('stale'));
  coalescer.schedule(2, () => seen.push('fresh'));
  frames.run();
  assert.deepEqual(seen, ['fresh'], 'the callback from the newest schedule() runs');
}

// ── cancel() drops the pending frame (unmount, or a drag taking over) ───────
{
  const frames = fakeFrames();
  const applied: number[] = [];
  const coalescer = createFrameCoalescer<number>(frames.schedule, frames.cancel);
  coalescer.schedule(7, (v) => applied.push(v));
  coalescer.cancel();
  assert.equal(frames.scheduled, 0, 'the scheduled frame is cancelled, not left armed');
  frames.run();
  assert.equal(applied.length, 0, 'the cancelled value is never applied');
  assert.equal(coalescer.pending, false);

  // ...and the coalescer still works afterwards.
  coalescer.schedule(8, (v) => applied.push(v));
  frames.run();
  assert.deepEqual(applied, [8], 'scheduling works again after a cancel');
}

// ── a throwing apply must not wedge the next frame ──────────────────────────
{
  const frames = fakeFrames();
  const applied: number[] = [];
  const coalescer = createFrameCoalescer<number>(frames.schedule, frames.cancel);
  coalescer.schedule(1, () => { throw new Error('render blew up'); });
  assert.throws(() => frames.run(), /render blew up/);
  assert.equal(coalescer.pending, false, 'the failed frame released its handle');

  coalescer.schedule(2, (v) => applied.push(v));
  frames.run();
  assert.deepEqual(applied, [2], 'later values still get applied');
}

console.log('frameCoalescer.verify: pointer reports collapse to one application per frame');
