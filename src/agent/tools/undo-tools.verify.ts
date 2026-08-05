// Runnable check: `npx tsx src/agent/tools/undo-tools.verify.ts`.
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

{
  assert.deepEqual([...UNDO_TOOL_NAMES].sort(), ['redo_last_change', 'undo_last_change']);
  assert.equal(UNDO_TOOL_SCHEMAS.length, 2);
  assert.match(UNDO_TOOL_SCHEMAS[0]!.description ?? '', /confirm|proposed/i);
  assert.match(UNDO_TOOL_SCHEMAS[1]!.description ?? '', /redo/i);
}

{
  const previous = docOf([item('a', 0), item('b', 30)]);
  const current = docOf([item('a', 0)]);
  const dispatched: AnyAction[] = [];
  const r = execUndoTool('undo_last_change', {
    commands: { applyDoc: (d: ProjectDoc) => dispatched.push({ type: 'tl.setDoc', doc: d } as unknown as AnyAction) } as never,
    getDoc: () => current,
    getUndoTarget: () => previous,
  }) as Record<string, unknown>;
  assert.equal(r.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal((dispatched[0] as unknown as { type: string }).type, 'tl.setDoc');
  const restored = (dispatched[0] as unknown as { doc: ProjectDoc }).doc;
  assert.deepEqual(restored.timelines[0]!.items.map((i) => i.id), ['a', 'b']);
}

{
  const redone = docOf([item('a', 0), item('b', 30), item('c', 60)]);
  const current = docOf([item('a', 0)]);
  const dispatched: ProjectDoc[] = [];
  const r = execUndoTool('redo_last_change', {
    commands: { applyDoc: (d: ProjectDoc) => { dispatched.push(d); } } as never,
    getDoc: () => current,
    getRedoTarget: () => redone,
  }) as Record<string, unknown>;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 'redone project state');
  assert.deepEqual(dispatched[0]!.timelines[0]!.items.map((i) => i.id), ['a', 'b', 'c']);
}

{
  const guardCommands = { applyDoc: () => { throw new Error('must not edit'); } } as never;
  assert.match(
    (execUndoTool('undo_last_change', {
      commands: guardCommands, getDoc: () => docOf([]), getUndoTarget: () => null,
    }) as { error?: string }).error ?? '',
    /nothing to undo/,
  );
  assert.match(
    (execUndoTool('redo_last_change', {
      commands: guardCommands, getDoc: () => docOf([]), getRedoTarget: () => null,
    }) as { error?: string }).error ?? '',
    /nothing to redo/,
  );
  assert.match(
    (execUndoTool('redo_last_change', {
      commands: guardCommands, getDoc: () => docOf([]), getRedoTarget: undefined,
    }) as { error?: string }).error ?? '',
    /unavailable/,
  );
}

{
  const r = execUndoTool('undo_last_change', {
    commands: { applyDoc: () => undefined } as never,
    getDoc: () => docOf([], 'tl2'),
    getUndoTarget: () => docOf([], 'tl1'),
  }) as Record<string, unknown>;
  assert.match(String(r.note ?? ''), /active timeline/i);
}

{
  const base = docOf([item('a', 0)]);
  let h = { past: [] as ProjectDoc[], present: base, future: [] as ProjectDoc[] };
  const added = docOf([item('a', 0), item('b', 30)]);
  h = historyReduce(h, { type: 'tl.setDoc', doc: added } as never);
  assert.equal(h.past.length, 1);
  h = historyReduce(h, { type: 'undo' });
  assert.equal(h.future.length, 1, 'undo fills redo stack');
  assert.deepEqual(h.future[0]!.timelines[0]!.items.map((i) => i.id), ['a', 'b']);
  const redoTarget = h.future[0]!;
  h = historyReduce(h, { type: 'tl.setDoc', doc: redoTarget } as never);
  assert.deepEqual(h.present.timelines[0]!.items.map((i) => i.id), ['a', 'b'], 'agent-style redo via applyDoc');
}

console.log('undo-tools.verify: ok (undo+redo proposal paths)');
