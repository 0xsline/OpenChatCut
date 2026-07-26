// Runnable check: `npx tsx src/editor/historyGesture.verify.ts`.
// 连续手势(拖滑块、拖取色器)必须只留一条撤销记录:撤销要回到「拖之前」,而不是
// 上一个刻度。没有它的话音量 0→2 按 0.05 步进会压进约 40 条快照,而上限只有 100
// ——拖两次就把用户真正的编辑历史挤没了。
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

// ── 不开手势:每一步都是一条历史(原有行为,键盘单次调整仍然如此) ──
{
  let h = start();
  for (const v of [1.1, 1.2, 1.3]) h = setVolume(h, v);
  assert.equal(h.past.length, 3, '没有手势边界时逐步记录');
}

// ── 开了手势:40 步只留一条,且撤销回到拖之前 ──
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

// ── 两次独立手势 = 两条历史,不会跨手势合并 ──
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

// ── 手势中途没有产生改动:不该凭空多出一条历史 ──
{
  let h = start();
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = historyReduce(h, { type: 'history.endGesture' });
  assert.equal(h.past.length, 0);
  assert.equal(h.gesture, undefined, '结束后手势状态清干净');
}

// ── 手势期间照样清空 redo 分支(和普通编辑一致) ──
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

// ── undo/redo 会关掉手势状态,避免拖动中途撤销后状态卡住 ──
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

// ── 重复 begin 不会重复开手势 ──
{
  let h = start();
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = setVolume(h, 1.2);
  h = historyReduce(h, { type: 'history.beginGesture' });
  h = setVolume(h, 1.4);
  assert.equal(h.past.length, 1, '仍然只有一条');
}

console.log('historyGesture.verify: ok (逐步/40 步合一/跨手势不合并/空手势/清 redo/undo 收尾/重复 begin)');
