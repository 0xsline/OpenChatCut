// Runnable check: `npx tsx src/agent/tools/undo-tools.verify.ts`.
// 验证 undo_last_change:走提案(产出 applyDoc 而不是动历史栈)、无历史时拒绝、
// 会话不支持时拒绝、切时间线的回滚附说明,并经真 historyReduce 确认「撤销目标」
// 就是上一步状态、且回滚本身仍可再被撤销。
import assert from 'node:assert/strict';
import { execUndoTool, UNDO_TOOL_NAMES, UNDO_TOOL_SCHEMAS } from './undo-tools';
import { historyReduce } from '../../editor/reduce';
import type { AnyAction } from '../../editor/store';
import type { ProjectDoc, Timeline, TimelineItem } from '../../editor/types';

const item = (id: string, startFrame: number): TimelineItem =>
  ({ id, track: 'A1', startFrame, durationInFrames: 30, kind: 'audio', name: id, src: `/m/${id}.wav` } as TimelineItem);

const timeline = (id: string, items: TimelineItem[]): Timeline => ({
  id, name: id, order: 0,
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { A1: { kind: 'audio' } }, trackOrder: ['A1'],
  items,
});

const docOf = (items: TimelineItem[], activeTimelineId = 'tl1'): ProjectDoc => ({
  version: 3, assets: [], mediaFolders: [],
  activeTimelineId,
  timelines: [timeline('tl1', items), timeline('tl2', [])],
});

// ── schema:无参数、单一工具名 ──
{
  assert.deepEqual([...UNDO_TOOL_NAMES], ['undo_last_change']);
  const schema = UNDO_TOOL_SCHEMAS[0]!;
  assert.deepEqual(schema.input_schema.required, [], '不需要参数');
  assert.match(schema.description ?? '', /confirm|proposed/i, '描述里说明仍走用户确认');
}

// ── 正常路径:产出 applyDoc(一次普通编辑),而不是历史操作 ──
{
  const previous = docOf([item('a', 0), item('b', 30)]);
  const current = docOf([item('a', 0)]);
  const dispatched: AnyAction[] = [];
  const r = execUndoTool('undo_last_change', {
    commands: { applyDoc: (d: ProjectDoc) => dispatched.push({ type: 'tl.setDoc', doc: d } as unknown as AnyAction) } as never,
    getDoc: () => current,
    getUndoTarget: () => previous,
  }) as Record<string, unknown>;
  assert.equal(r.ok, true, '成功');
  assert.equal(dispatched.length, 1, '只提一次整工程替换');
  assert.equal((dispatched[0] as unknown as { type: string }).type, 'tl.setDoc', '走 applyDoc → tl.setDoc(会被提案捕获)');
  const restored = (dispatched[0] as unknown as { doc: ProjectDoc }).doc;
  assert.deepEqual(restored.timelines[0]!.items.map((i) => i.id), ['a', 'b'], '恢复到上一步的内容');
  assert.equal(r.note, undefined, '同一时间线时不附额外说明');
}

// ── 无历史 / 会话不支持 → 明确拒绝,且不产生任何编辑 ──
{
  const guardCommands = { applyDoc: () => { throw new Error('must not edit'); } } as never;
  const noHistory = execUndoTool('undo_last_change', {
    commands: guardCommands, getDoc: () => docOf([]), getUndoTarget: () => null,
  }) as { error?: string };
  assert.match(noHistory.error ?? '', /nothing to undo/, '无历史时拒绝');

  const unsupported = execUndoTool('undo_last_change', {
    commands: guardCommands, getDoc: () => docOf([]), getUndoTarget: undefined,
  }) as { error?: string };
  assert.match(unsupported.error ?? '', /unavailable/, '会话不支持时拒绝');

  const unknown = execUndoTool('nope', {
    commands: guardCommands, getDoc: () => docOf([]), getUndoTarget: () => docOf([]),
  }) as { error?: string };
  assert.match(unknown.error ?? '', /unknown tool/, '未知工具名拒绝');
}

// ── 回滚跨时间线时给出说明(避免用户以为编辑器自己乱跳) ──
{
  const r = execUndoTool('undo_last_change', {
    commands: { applyDoc: () => undefined } as never,
    getDoc: () => docOf([], 'tl2'),
    getUndoTarget: () => docOf([], 'tl1'),
  }) as Record<string, unknown>;
  assert.match(String(r.note ?? ''), /active timeline/i, '活动时间线也回退时要说明');
}

// ── 经真 historyReduce:撤销目标就是上一步,且回滚后仍可再撤销 ──
{
  const base = docOf([item('a', 0)]);
  let h = { past: [] as ProjectDoc[], present: base, future: [] as ProjectDoc[] };
  const added = docOf([item('a', 0), item('b', 30)]);
  h = historyReduce(h, { type: 'tl.setDoc', doc: added } as never);
  assert.equal(h.past.length, 1, '一次编辑进一步历史');
  const target = h.past[h.past.length - 1]!;
  assert.deepEqual(target.timelines[0]!.items.map((i) => i.id), ['a'], '撤销目标 = 编辑前状态');

  // 工具把该快照作为普通编辑提出 → 批准后又是一步历史(回滚本身可撤销)
  h = historyReduce(h, { type: 'tl.setDoc', doc: target } as never);
  assert.deepEqual(h.present.timelines[0]!.items.map((i) => i.id), ['a'], '回滚生效');
  assert.equal(h.past.length, 2, '回滚自身也是一步历史,可以再被撤销');
}

console.log('undo-tools.verify: ok (提案路径/无历史拒绝/跨时间线说明/真 historyReduce)');
