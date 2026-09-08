import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { execLoudnessTool } from '../agent/tools/loudness-tools';
import type { AgentContext } from '../agent/context';
import { historyReduce, type History } from '../editor/reduce';
import type { EditorCommands } from '../editor/store';
import { activeEditorState, type ProjectDoc, type TimelineItem } from '../editor/types';
import { analyzeLoudnessBatch } from './loudness';
import { normalizeSelectedLoudness } from './normalizeSelectedLoudness';

let active = 0;
let peak = 0;
const calls: string[] = [];
const analyze = async (src: string) => {
  calls.push(src);
  peak = Math.max(peak, ++active);
  await new Promise((resolve) => setTimeout(resolve, 2));
  active -= 1;
  if (src === 'broken') throw new Error('broken');
  return -24;
};
const results = await analyzeLoudnessBatch(['one', 'one', 'two', 'three', 'broken', 'broken'], analyze);
assert.equal(peak, 2);
assert.deepEqual(calls, ['one', 'two', 'three', 'broken']);
assert.equal(results.get('one')?.status, 'fulfilled');
assert.equal(results.get('broken')?.status, 'rejected');
await analyzeLoudnessBatch(['one'], analyze);
assert.equal(calls.filter((src) => src === 'one').length, 2, 'separate operations must not reuse analysis');
assert.equal((await analyzeLoudnessBatch([], analyze)).size, 0);

const audio = (id: string, src: string): TimelineItem => ({
  id, name: id, src, kind: 'audio', track: 'A1', startFrame: 0, durationInFrames: 30,
});
const initial: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'main',
  timelines: [{ id: 'main', name: 'main', order: 0, width: 1920, height: 1080, fps: 30,
    selectedId: null, items: [audio('first', '/one.wav'), audio('second', '/one.wav')] }],
};
let history: History = { past: [], present: structuredClone(initial), future: [] };
const getDoc = () => history.present;
const getState = () => activeEditorState(getDoc());
const commands = {
  batch: (actions, label) => { history = historyReduce(history, { type: 'batch', actions, label }); },
  setItemVolume: (id, volume) => { history = historyReduce(history, { type: 'setVolume', id, volume }); },
} as Pick<EditorCommands, 'batch' | 'setItemVolume'>;
const originalFetch = globalThis.fetch;
const originalContext = globalThis.OfflineAudioContext;
let beforeResponse = () => {};
const fetches: string[] = [];
globalThis.fetch = async (input) => {
  fetches.push(String(input));
  beforeResponse();
  return new Response(new Uint8Array([1]), { status: String(input).includes('broken') ? 500 : 200 });
};
globalThis.OfflineAudioContext = class {
  async decodeAudioData() {
    return { numberOfChannels: 1, length: 4, sampleRate: 44100, getChannelData: () => new Float32Array([0.1, -0.1, 0.1, -0.1]) };
  }
} as unknown as typeof OfflineAudioContext;

function reset(items = initial.timelines[0].items) {
  history = { past: [], present: { ...structuredClone(initial), timelines: [{ ...initial.timelines[0], items }] }, future: [] };
  beforeResponse = () => {};
  fetches.length = 0;
}

try {
  await normalizeSelectedLoudness(getState().items, getState, getDoc, commands);
  assert.deepEqual(fetches, ['/one.wav']);
  assert.equal(history.past.length, 1, 'UI normalization remains one atomic undo step');
  assert.equal(getState().items[0].volume, getState().items[1].volume);
  assert.deepEqual(historyReduce(history, { type: 'undo' }).present, initial);

  reset([audio('first', '/one.wav'), audio('second', '/broken.wav')]);
  await assert.rejects(normalizeSelectedLoudness(getState().items, getState, getDoc, commands));
  assert.equal(history.past.length, 0, 'one decode failure leaves all selected gains unchanged');

  reset();
  beforeResponse = () => {
    history = { ...history, present: { ...getDoc(), timelines: [{ ...getDoc().timelines[0],
      items: [audio('first', '/relinked.wav'), getState().items[1]] }] } };
  };
  await assert.rejects(normalizeSelectedLoudness(getState().items, getState, getDoc, commands), /source changed/);
  assert.equal(history.past.length, 0, 'relink cannot apply gain measured from the old source');

  reset();
  beforeResponse = () => { history.present = { ...getDoc(), activeTimelineId: 'other' }; };
  await assert.rejects(normalizeSelectedLoudness(getState().items, getState, getDoc, commands), /source changed/);
  assert.equal(history.past.length, 0, 'switching timelines aborts the entire UI operation');

  reset([audio('first', '/one.wav'), audio('second', '/one.wav'), audio('bad', '/broken.wav'), audio('missing', '')]);
  const ctx: AgentContext = { getDoc, getState, commands: commands as EditorCommands, getCreativeMode: () => null, templates: [], audio: [] };
  const result = await execLoudnessTool('normalize_loudness', {}, ctx) as { normalized: { itemId: string }[]; skipped: { itemId: string }[] };
  assert.deepEqual(result.normalized.map((entry) => entry.itemId), ['first', 'second']);
  assert.deepEqual(result.skipped.map((entry) => entry.itemId), ['bad', 'missing']);
  assert.deepEqual(fetches, ['/one.wav', '/broken.wav']);
  assert.equal(history.past.length, 2, 'Agent retains its original per-item command/undo semantics');

  reset();
  beforeResponse = () => { history.present = { ...getDoc(), activeTimelineId: 'other' }; };
  const stale = await execLoudnessTool('normalize_loudness', {}, ctx) as { normalized: unknown[]; skipped: unknown[] };
  assert.equal(stale.normalized.length, 0);
  assert.equal(stale.skipped.length, 2);
  assert.equal(history.past.length, 0);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.OfflineAudioContext = originalContext;
}
console.log('loudnessBatch.verify: dedup, concurrency, retries, partial success, atomic undo, and stale sources passed');
