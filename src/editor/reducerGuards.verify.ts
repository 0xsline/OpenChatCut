// Reducer boundary guards: numeric validation (finite + round + clamp) on the
// LLM/tool-facing action channels, and the no-op reference-stability contract
// (a rejected/no-op action must return the ORIGINAL state, or historyReduce
// records a phantom undo step and clears redo). npx tsx src/editor/reducerGuards.verify.ts
import assert from 'node:assert/strict';
import { projectReduce, reduce } from './reduce';
import type { ProjectDoc, TimelineItem, TimelineState } from './types';
import type { TransitionItem } from './transitionTypes';

const clip = (over: Partial<TimelineItem>): TimelineItem =>
  ({ id: 'a', track: 'V1', startFrame: 0, durationInFrames: 60, kind: 'video', name: 'clip', src: '/m.mp4', ...over });

const transition: TransitionItem = {
  id: 't1', type: 'cross-dissolve', durationInFrames: 10,
  outgoingItemId: 'a', incomingItemId: 'b', trackId: 'V1',
};

/** Two adjacent clips a[0,60) b[60,120) with a valid transition at the seam. */
const seamState = (): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [clip({}), clip({ id: 'b', startFrame: 60 })],
  transitions: [transition],
});

// ── no-op reference stability(有转场在场时被拒/被夹为 0 的 action 不得产生新 state) ──
{
  const s = seamState();
  assert.equal(reduce(s, { type: 'move', id: 'b', startFrame: 50 }), s,
    'move clamped to zero delta returns the ORIGINAL state (no phantom history)');
  assert.equal(reduce(s, { type: 'move', id: 'missing', startFrame: 10 }), s,
    'move of an unknown id returns the original state');
  assert.equal(reduce(s, { type: 'move', id: 'b', startFrame: Infinity }), s,
    'non-finite move target is rejected, state untouched');
  assert.equal(reduce(s, { type: 'move', id: 'b', startFrame: Number.NaN }), s,
    'NaN move target is rejected, state untouched');
  console.log('no-op reference stability: OK');
}

// ── move:小数帧取整入档 ──────────────────────────────────────────────────
{
  const out = reduce(seamState(), { type: 'move', id: 'b', startFrame: 100.6 });
  assert.equal(out.items.find((it) => it.id === 'b')?.startFrame, 101,
    'fractional move target is rounded to an integral frame');
  console.log('move rounding: OK');
}

// ── split:小数切点取整,边界仍拒绝 ────────────────────────────────────────
{
  const out = reduce(seamState(), { type: 'split', id: 'a', atFrame: 30.4, newId: 'a2' });
  const left = out.items.find((it) => it.id === 'a');
  const right = out.items.find((it) => it.id === 'a2');
  assert.equal(left?.durationInFrames, 30, 'left duration is integral');
  assert.equal(right?.startFrame, 30, 'right start is integral');
  const s = seamState();
  assert.equal(reduce(s, { type: 'split', id: 'a', atFrame: 0.4, newId: 'a2' }), s,
    'cut that rounds onto the clip start is rejected');
  assert.equal(reduce(s, { type: 'split', id: 'a', atFrame: Number.NaN, newId: 'a2' }), s,
    'NaN cut point is rejected');
  console.log('split rounding: OK');
}

// ── retime:小数 startFrame/durationInFrames 取整 ─────────────────────────
{
  const out = reduce(seamState(), { type: 'retime', id: 'b', startFrame: 70.4, durationInFrames: 50.6 });
  const b = out.items.find((it) => it.id === 'b');
  assert.equal(b?.startFrame, 70, 'retime startFrame rounded');
  assert.equal(b?.durationInFrames, 51, 'retime duration rounded');
  console.log('retime rounding: OK');
}

// ── reorderTrackItems.starts:LLM 通道,非法整体拒绝、小数取整 ──────────────
{
  const s = seamState();
  assert.equal(reduce(s, {
    type: 'reorderTrackItems', track: 'V1', orderedIds: ['a', 'b'], starts: { b: -500 },
  }), s, 'negative pinned start rejects the whole action');
  assert.equal(reduce(s, {
    type: 'reorderTrackItems', track: 'V1', orderedIds: ['a', 'b'], starts: { b: Number.NaN },
  }), s, 'NaN pinned start rejects the whole action');
  const out = reduce(s, {
    type: 'reorderTrackItems', track: 'V1', orderedIds: ['a', 'b'], starts: { b: 70.75 },
  });
  assert.equal(out.items.find((it) => it.id === 'b')?.startFrame, 71,
    'fractional pinned start is rounded');
  console.log('reorderTrackItems starts guard: OK');
}

// ── setVolume / setFade / setSpeed:NaN 拒绝 ─────────────────────────────
{
  const s = seamState();
  assert.equal(reduce(s, { type: 'setVolume', id: 'a', volume: Number.NaN }), s, 'NaN volume rejected');
  assert.equal(reduce(s, { type: 'setFade', id: 'a', fadeInFrames: Number.NaN }), s, 'NaN fade rejected');
  assert.equal(reduce(s, { type: 'setSpeed', id: 'a', rate: Number.NaN }), s, 'NaN rate rejected');
  assert.equal(reduce(s, { type: 'setSpeed', id: 'a', rate: Infinity }), s, 'Infinite rate rejected');
  const rated = reduce(s, { type: 'setSpeed', id: 'a', rate: 2 });
  assert.equal(rated.items.find((it) => it.id === 'a')?.playbackRate, 2, 'valid rate still applies');
  console.log('setVolume/setFade/setSpeed guards: OK');
}

// ── setCanvas / updateMarker ────────────────────────────────────────────
{
  const s = seamState();
  assert.equal(reduce(s, { type: 'setCanvas', width: 0, height: 1080 }), s, 'zero canvas rejected');
  assert.equal(reduce(s, { type: 'setCanvas', width: Number.NaN, height: 1080 }), s, 'NaN canvas rejected');
  const sized = reduce(s, { type: 'setCanvas', width: 1280.4, height: 720.6 });
  assert.equal(sized.width, 1280, 'canvas width rounded');
  assert.equal(sized.height, 721, 'canvas height rounded');

  const marked: TimelineState = {
    ...seamState(),
    markers: [{ id: 'm1', scope: 'project', fromFrame: 10, durationFrames: 0, note: 'x', color: 'blue' }],
  };
  assert.equal(reduce(marked, { type: 'updateMarker', id: 'm1', patch: { fromFrame: Number.NaN } }), marked,
    'NaN marker patch rejected');
  const moved = reduce(marked, { type: 'updateMarker', id: 'm1', patch: { fromFrame: -5.4 } });
  assert.equal(moved.markers?.[0]?.fromFrame, 0, 'negative marker frame clamps to 0');
  console.log('setCanvas/updateMarker guards: OK');
}

// ── tl.retarget(projectReduce 层) ────────────────────────────────────────
{
  const p: ProjectDoc = {
    version: 3,
    assets: [],
    mediaFolders: [],
    timelines: [{ ...seamState(), id: 'tl1', name: '序列 1', order: 0 }],
    activeTimelineId: 'tl1',
  } as unknown as ProjectDoc;
  assert.equal(projectReduce(p, { type: 'tl.retarget', id: 'tl1', width: 0, height: 1080 }), p,
    'zero retarget rejected');
  assert.equal(projectReduce(p, { type: 'tl.retarget', id: 'tl1', width: Number.NaN, height: 1080 }), p,
    'NaN retarget rejected');
  const out = projectReduce(p, { type: 'tl.retarget', id: 'tl1', width: 1280.4, height: 720.6 });
  assert.equal(out.timelines[0]?.width, 1280, 'retarget width rounded');
  assert.equal(out.timelines[0]?.height, 721, 'retarget height rounded');
  console.log('tl.retarget guards: OK');
}

console.log('\nreducerGuards.verify: ALL PASSED');
