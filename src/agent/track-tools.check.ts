// Runnable source-contract check: `npx tsx src/agent/track-tools.check.ts`.
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import type { TimelineState } from '../editor/types';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from './context';
import { execTrackTool } from './track-tools';

const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [
    { id: 'a', track: 'A1', startFrame: 10, durationInFrames: 10, name: 'a', kind: 'audio', src: '/a.mp3' },
    { id: 'b', track: 'A1', startFrame: 50, durationInFrames: 10, name: 'b', kind: 'audio', src: '/b.mp3' },
  ],
};
const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, templates: [], audio: [] };

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

console.log('track-tools.check: ok');
