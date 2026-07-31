// Runnable check: `npx tsx src/editor/historyGesture.verify.ts`.
// Continuous gestures (drag the slider, drag the color picker) must leave only one undo record: the undo must go back to "before dragging" instead of
// Previous tick. Without it, volume 0→2 will push in about 40 snapshots in 0.05 steps, and the upper limit is only 100
//  — Drag twice and the user’s real editing history is squeezed out.
import assert from 'node:assert/strict';
import { historyReduce, type History } from './reduce';
import type { ProjectDoc, TimelineItem } from './types';

const item = (volume: number): TimelineItem => ({
  id: 'a', track: 'A1', startFrame: 0, durationInFrames: 60,
  kind: 'audio', name: 'a', src: '/m/a.wav', volume,
} as TimelineItem);

const docOf = (volume: number): ProjectDoc => ({
  version: 3, assets: [], mediaFolders: [], activeTimelineId: 'tl1',
  timelines: [{
    id: 'tl1', name: 'main', order: 0, fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { A1: { kind: 'audio' } }, trackOrder: ['A1'], items: [item(volume)],
  }],
} as unknown as ProjectDoc);

const start = (): History => ({ past: [], present: docOf(1), future: [] });
const volumeOf = (h: History) => h.present.timelines[0]!.items[0]!.volume;
const setVolume = (h: History, volume: number) => historyReduce(h, { type: 'setVolume', id: 'a', volume });

// ── Disable gestures: each step is a history (original behavior, single keyboard adjustment is still the same) ──
{
  let h = start();
  for (const v of [1.1, 1.2, 1.3]) h = setVolume(h, v);
  assert.equal(h.past.length, 3, '没有手势边界时逐步记录');
}

// ── Gestures enabled: Only one of the 40 steps is left, and the undo returns to before dragging ──
{
  let h = start();
  h = historyReduce(h, { type: 'history.beginGesture' });
  assert.equal(h.past.length, 0, '开始手势本身不动历史');
  for (let i = 1; i <= 40; i += 1) h = setVolume(h, Math.round((1 + i * 0.025) * 1000) / 1000);
  h = historyReduce(h, { type: 'history.endGesture' });

  assert.equal(h.past.length, 1, `40 步只该留 1 条历史,实得 ${h.past.length}`);
  assert.equal(volumeOf(h), 2, '当前值是拖到的最终值');
  const undone = historyReduce(h, { type: 'undo' });
  assert.equal(volumeOf(undone), 1, '撤销回到拖之前,而不是上一个刻度');
  assert.equal(undone.past.length, 0);
}

// ── Two independent gestures = two histories, will not be merged across gestures ──
{
  let h = start();
  for (const [a, b] of [[1.5, 1.8], [0.5, 0.2]] as const) {
    h = historyReduce(h, { type: 'history.beginGesture' });
    h = setVolume(h, a);
    h = setVolume(h, b);
    h = historyReduce(h, { type: 'history.endGesture' });
  }
  assert.equal(h.past.length, 2, '每次手势各留一条');
  assert.equal(volumeOf(h), 0.2);
  assert.equal(volumeOf(historyReduce(h, { type: 'undo' })), 1.8, '撤销回到第二次手势之前');
}

// ── The gesture did not change during the process: an extra piece of history should not be created out of thin air──
{
  let h = start();
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = historyReduce(h, { type: 'history.endGesture' });
  assert.equal(h.past.length, 0);
  assert.equal(h.gesture, undefined, '结束后手势状态清干净');
}

// ── The redo branch will still be cleared during the gesture (the same as normal editing) ──
{
  let h = start();
  h = setVolume(h, 1.5);
  h = historyReduce(h, { type: 'undo' });
  assert.equal(h.future.length, 1, '有可重做的分支');
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = setVolume(h, 0.8);
  h = setVolume(h, 0.6);
  assert.equal(h.future.length, 0, '新编辑清空重做分支');
  assert.equal(h.past.length, 1);
}

// ── undo/redo will turn off the gesture state to prevent the state from getting stuck after undoing the drag ──
{
  let h = start();
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = setVolume(h, 1.4);
  assert.equal(h.gesture, 'pushed');
  h = historyReduce(h, { type: 'undo' });
  assert.equal(h.gesture, undefined, '撤销后手势状态清掉');
  h = setVolume(h, 1.9);
  assert.equal(h.past.length, 1, '之后的编辑照常记录');
}

// ── Repeating begin will not repeat the open gesture──
{
  let h = start();
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = setVolume(h, 1.2);
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = setVolume(h, 1.4);
  assert.equal(h.past.length, 1, '仍然只有一条');
}

console.log('historyGesture.verify: ok (逐步/40 步合一/跨手势不合并/空手势/清 redo/undo 收尾/重复 begin)');
