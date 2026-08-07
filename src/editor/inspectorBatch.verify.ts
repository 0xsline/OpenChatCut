import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import assert from 'node:assert/strict';
import { inspectorMixedValue, planInspectorBatch } from './inspectorBatch';
import { historyReduce, reduce } from './reduce';
import type { ProjectDoc, TimelineItem, TimelineState } from './types';

const item = (id: string, track: string, scale: number, volume?: number): TimelineItem => ({
  id,
  track,
  startFrame: id === 'a' ? 0 : 20,
  durationInFrames: 20,
  kind: 'video',
  name: id,
  transform: { scale, x: id === 'a' ? 2 : 8 },
  filters: { brightness: id === 'a' ? 0.8 : 1.2, contrast: 1 },
  volume,
});

const a = item('a', 'V1', 1);
const b = item('b', 'V1', 2, 1);
const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [a, b],
  selectedId: 'b',
  selectedIds: ['a', 'b'],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video', locked: true } },
  trackOrder: ['V2', 'V1'],
};

assert.deepEqual(inspectorMixedValue([a, b], (entry) => entry.transform?.scale ?? 1), { mixed: true, value: undefined });
assert.deepEqual(inspectorMixedValue([a, b], (entry) => entry.volume ?? 1), { mixed: false, value: 1 }, 'undefined 默认值与显式默认值不应假 mixed');

const transformPlan = planInspectorBatch(
  state,
  ['a', 'b'],
  (entry) => ({ type: 'setTransform', id: entry.id, patch: { x: 42 } }),
  (entry) => entry.kind !== 'audio',
);
assert.equal(transformPlan.ok, true);
const transformed = transformPlan.actions.reduce(reduce, state);
assert.deepEqual(transformed.items.map((entry) => entry.transform?.x), [42, 42]);
assert.deepEqual(transformed.items.map((entry) => entry.transform?.scale), [1, 2], '未显式修改的 mixed scale 不能被写平');
assert.deepEqual(transformed.items.map((entry) => entry.filters?.brightness), [0.8, 1.2], '其他 mixed 字段完全不应进入 patch');

const timeline = { ...state, id: 'tl1', name: 'main', order: 0 };
const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], timelines: [timeline], activeTimelineId: 'tl1' };
const committed = historyReduce({ past: [], present: doc, future: [] }, {
  type: 'batch', label: 'Inspector multi-edit', actions: transformPlan.actions,
});
assert.equal(committed.past.length, 1, '多选编辑只占一个 undo step');
assert.deepEqual(historyReduce(committed, { type: 'undo' }).present, doc);

// Real preflight failure: one selected target is locked. No actions are released, so the unlocked target cannot publish alone.
const lockedState: TimelineState = {
  ...state,
  items: [a, { ...b, track: 'V2' }],
};
const lockedPlan = planInspectorBatch(lockedState, ['a', 'b'], (entry) => ({
  type: 'setFilters', id: entry.id, patch: { brightness: 1.5 },
}));
assert.deepEqual(lockedPlan, { ok: false, actions: [], reason: 'locked-track' });
const afterRejected = lockedPlan.ok ? lockedPlan.actions.reduce(reduce, lockedState) : lockedState;
assert.strictEqual(afterRejected, lockedState, '失败必须回滚到原 snapshot，不能发布第一个 item 的修改');
assert.equal(afterRejected.items[0]?.filters?.brightness, 0.8);

// Planner exceptions are also all-or-nothing: an earlier planned target is discarded when a later one fails.
const throwingPlan = planInspectorBatch(state, ['a', 'b'], (entry) => {
  if (entry.id === 'b') throw new Error('simulated planning failure');
  return { type: 'setVolume', id: entry.id, volume: 0.5 };
});
assert.deepEqual(throwingPlan, { ok: false, actions: [], reason: 'planning-failed' });

console.log('inspectorBatch.verify: ok (mixed/default/显式 patch/atomic batch/locked+exception rollback)');
