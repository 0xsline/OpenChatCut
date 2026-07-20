// Runnable contract check: `npx tsx src/agent/track-tools.check.ts`.
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import { reduce } from '../../editor/reduce';
import { timelineTrackIds, type TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execTrackTool } from './track-tools';

const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [
    { id: 'a', track: 'A1', startFrame: 10, durationInFrames: 10, name: 'a', kind: 'audio', src: '/a.mp3' },
    { id: 'b', track: 'A1', startFrame: 50, durationInFrames: 10, name: 'b', kind: 'audio', src: '/b.mp3' },
  ],
};
const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

const before = await execTrackTool('edit_track', { action: 'list' }, ctx) as { id: string; alias: string }[];
const oldV2 = before.find((track) => track.alias === 'V2')!.id;
const made = await execTrackTool('edit_track', { action: 'create', json: '{"trackType":"video","name":"Overlay"}' }, ctx) as { created: { id: string; alias: string }[] };
assert.strictEqual(made.created[0].alias, 'V3');
const afterCreate = await execTrackTool('edit_track', { action: 'list' }, ctx) as { id: string; alias: string }[];
assert.strictEqual(afterCreate.find((track) => track.id === oldV2)!.alias, 'V2', 'stable id survives alias calculation');

await execTrackTool('edit_track', { action: 'tighten', trackId: 'A1' }, ctx);
assert.deepStrictEqual(draft.getState().items.filter((item) => item.track === draft.getState().items[0].track).map((item) => item.startFrame), [10, 20]);
assert.deepStrictEqual(await execTrackTool('edit_track', { action: 'delete', trackId: 'A1' }, ctx), {
  error: 'track is not empty', tracks: [(await execTrackTool('edit_track', { action: 'list' }, ctx) as { alias: string }[]).find((track) => track.alias === 'A1')],
});
await execTrackTool('edit_track', { action: 'delete', trackId: made.created[0].id }, ctx);
assert.ok(!(await execTrackTool('edit_track', { action: 'list' }, ctx) as { id: string }[]).some((track) => track.id === made.created[0].id));

// ── Lock: update lands, list reports it, edits freeze ──────────────────────
const lockRes = await execTrackTool('edit_track', { action: 'update', trackId: 'A1', json: '{"locked":true}' }, ctx) as { ok?: boolean; track: { locked: boolean } };
assert.strictEqual(lockRes.track.locked, true, 'update locked:true lands');
const lockedState = draft.getState();
assert.strictEqual(reduce(lockedState, { type: 'move', id: 'a', startFrame: 99 }), lockedState, 'move on locked track no-ops');
assert.strictEqual(reduce(lockedState, { type: 'retime', id: 'a', durationInFrames: 5 }), lockedState, 'retime on locked track no-ops');
assert.strictEqual(reduce(lockedState, { type: 'remove', id: 'a' }), lockedState, 'delete on locked track no-ops');
assert.strictEqual(reduce(lockedState, { type: 'split', id: 'a', atFrame: 15, newId: 'a2' }), lockedState, 'split on locked track no-ops');
assert.strictEqual(reduce(lockedState, { type: 'setVolume', id: 'a', volume: 0 }), lockedState, 'prop edit on locked track no-ops');
assert.strictEqual(
  reduce(lockedState, { type: 'add', item: { id: 'n', track: lockedState.items[0].track, durationInFrames: 5, name: 'n', kind: 'audio', src: '/n.mp3' } }),
  lockedState, 'nothing new lands on a locked track',
);
assert.deepStrictEqual(await execTrackTool('edit_track', { action: 'tighten', trackId: 'A1' }, ctx), { error: 'track is locked' });
await execTrackTool('edit_track', { action: 'update', trackId: 'A1', json: '{"locked":false}' }, ctx);
const unlockedList = await execTrackTool('edit_track', { action: 'list' }, ctx) as { alias: string; locked: boolean }[];
assert.strictEqual(unlockedList.find((track) => track.alias === 'A1')!.locked, false, 'unlock lands + list carries locked');

// Empty projects start with one video lane and no audio lane. Audio lanes
// may all be removed; the final video lane remains protected.
const empty: TimelineState = { fps: 30, width: 1920, height: 1080, selectedId: null, items: [] };
const oneAudioRemoved = reduce(empty, { type: 'track.delete', tracks: ['A2'] });
assert.deepStrictEqual(timelineTrackIds(oneAudioRemoved), ['V2', 'V1', 'A1']);
assert.deepStrictEqual(timelineTrackIds(reduce(oneAudioRemoved, { type: 'track.delete', tracks: ['A1'] })), ['V2', 'V1']);
const oneVideoRemoved = reduce(empty, { type: 'track.delete', tracks: ['V2'] });
assert.strictEqual(reduce(oneVideoRemoved, { type: 'track.delete', tracks: ['V1'] }), oneVideoRemoved, 'last video track is protected');

console.log('track-tools.check: ok');
