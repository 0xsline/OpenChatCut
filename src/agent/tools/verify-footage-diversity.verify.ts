import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { activeEditorState, type ProjectDoc } from '../../editor/types.ts';
import { execPlanningTool } from './planning-tools.ts';

// verify_footage_diversity reads the REAL V1 video items (timeline state) and flags clips
// reused >max_reuse + any clip on two consecutive shots. Mirrors the word_budget enforce gate.

const fps = 30;
const v = (id: string, src: string, startFrame: number) => ({
  id, track: 'V1', startFrame, durationInFrames: 180, kind: 'video' as const, name: id, src,
});

function ctxWith(items: ReturnType<typeof v>[]): AgentContext {
  const doc: ProjectDoc = {
    version: 3, assets: [], mediaFolders: [], activeTimelineId: 'tl',
    timelines: [{
      id: 'tl', name: 'Main', order: 0, fps, width: 1920, height: 1080,
      trackOrder: ['V1'], tracks: { V1: { kind: 'video' } }, selectedId: null, items,
    }],
  };
  return {
    commands: {} as unknown as EditorCommands,
    getState: () => activeEditorState(doc),
    getDoc: () => doc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  } satisfies AgentContext;
}

type Res = { status: string; total_clips: number; unique_clips: number; diversity_pct: number;
  over_reuse: Array<{ count: number }>; consecutive_duplicates: Array<{ shot: number }> };

// (1) all distinct → ok, 100% diversity
const ok = await execPlanningTool('verify_footage_diversity', {}, ctxWith([v('a', '/a.mp4', 0), v('b', '/b.mp4', 180), v('c', '/c.mp4', 360), v('d', '/d.mp4', 540)])) as Res;
assert.equal(ok.status, 'ok');
assert.equal(ok.total_clips, 4);
assert.equal(ok.unique_clips, 4);
assert.equal(ok.diversity_pct, 100);

// (2) same clip on two consecutive shots → LOW_DIVERSITY via consecutive_duplicates
const dup = await execPlanningTool('verify_footage_diversity', {}, ctxWith([v('a', '/a.mp4', 0), v('a2', '/a.mp4', 180), v('b', '/b.mp4', 360), v('c', '/c.mp4', 540)])) as Res;
assert.equal(dup.status, 'LOW_DIVERSITY');
assert.equal(dup.consecutive_duplicates.length, 1);
assert.equal(dup.consecutive_duplicates[0]!.shot, 1);

// (3) over-reuse with NO consecutive (a on shots 1,3,5 = 3×, default max 2) → LOW_DIVERSITY via over_reuse
const reuse = await execPlanningTool('verify_footage_diversity', {}, ctxWith([v('a', '/a.mp4', 0), v('b', '/b.mp4', 180), v('a3', '/a.mp4', 360), v('c', '/c.mp4', 540), v('a4', '/a.mp4', 720)])) as Res;
assert.equal(reuse.status, 'LOW_DIVERSITY');
assert.equal(reuse.over_reuse.length, 1);
assert.equal(reuse.over_reuse[0]!.count, 3);
assert.equal(reuse.consecutive_duplicates.length, 0);

// (4) same layout but max_reuse=3 → 3 uses allowed, no consecutive → ok
const allow = await execPlanningTool('verify_footage_diversity', { max_reuse: 3 }, ctxWith([v('a', '/a.mp4', 0), v('b', '/b.mp4', 180), v('a3', '/a.mp4', 360), v('c', '/c.mp4', 540), v('a4', '/a.mp4', 720)])) as Res;
assert.equal(allow.status, 'ok');

// (5) no footage → NO_FOOTAGE
const empty = await execPlanningTool('verify_footage_diversity', {}, ctxWith([])) as Res;
assert.equal(empty.status, 'NO_FOOTAGE');

// (6) no ctx → helpful error
const noc = await execPlanningTool('verify_footage_diversity', {}, undefined) as { error: string };
assert.match(String(noc.error), /context/i);

console.log('verify-footage-diversity.verify: ok (distinct/consecutive/over-reuse/max-reuse/no-footage/no-ctx)');
