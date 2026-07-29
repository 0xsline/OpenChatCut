// Runnable check: `npx tsx src/agent/tools/undo-tools.verify.ts`.
// Verify undo_last_change: take the proposal (output applyDoc instead of moving the history stack), reject when there is no history,
// Reject when session does not support, timeline-cut rollback with explanation, and confirm "undo target" through true historyReduce
// This is the previous state, and the rollback itself can still be undone.
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

// ── schema: no parameters, single tool name ──
{
  assert.deepEqual([...UNDO_TOOL_NAMES], ['undo_last_change']);
  const schema = UNDO_TOOL_SCHEMAS[0]!;
  assert.deepEqual(schema.input_schema.required, [], '不需要参数');
  assert.match(schema.description ?? '', /confirm|proposed/i, '描述里说明仍走用户确认');
}

// ── Normal path: output applyDoc (an ordinary edit) instead of historical operation ──
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

// ── No history / Session not supported → Explicitly reject and no edits will be made ──
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

// ── Provide instructions when rolling back across timelines (to prevent users from thinking that the editor is jumping around on its own) ──
{
  const r = execUndoTool('undo_last_change', {
    commands: { applyDoc: () => undefined } as never,
    getDoc: () => docOf([], 'tl2'),
    getUndoTarget: () => docOf([], 'tl1'),
  }) as Record<string, unknown>;
  assert.match(String(r.note ?? ''), /active timeline/i, '活动时间线也回退时要说明');
}

// ── It is true historyReduce: The undo target is the previous step, and it can still be undone after rolling back ──
{
  const base = docOf([item('a', 0)]);
  let h = { past: [] as ProjectDoc[], present: base, future: [] as ProjectDoc[] };
  const added = docOf([item('a', 0), item('b', 30)]);
  h = historyReduce(h, { type: 'tl.setDoc', doc: added } as never);
  assert.equal(h.past.length, 1, '一次编辑进一步历史');
  const target = h.past[h.past.length - 1]!;
  assert.deepEqual(target.timelines[0]!.items.map((i) => i.id), ['a'], '撤销目标 = 编辑前状态');

  // The tool proposes the snapshot as a normal edit → another step in history after approval (the rollback itself can be undone)
  h = historyReduce(h, { type: 'tl.setDoc', doc: target } as never);
  assert.deepEqual(h.present.timelines[0]!.items.map((i) => i.id), ['a'], '回滚生效');
  assert.equal(h.past.length, 2, '回滚自身也是一步历史,可以再被撤销');
}

console.log('undo-tools.verify: ok (提案路径/无历史拒绝/跨时间线说明/真 historyReduce)');
