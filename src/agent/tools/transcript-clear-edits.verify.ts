import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execTranscriptTool } from './transcript-tools';

const words = [
  { text: 'hello', start: 0, end: 400, speaker: 'A' },
  { text: 'world', start: 600, end: 1000, speaker: 'A' },
  { text: 'again', start: 1500, end: 2000, speaker: 'A' },
];

const clip: TimelineItem = {
  id: 'clip_voice',
  kind: 'audio',
  track: 'A1',
  startFrame: 0,
  durationInFrames: 60,
  name: 'voice',
  src: '/media/uploads/voice.wav',
  transcript: words,
  deletedWordIdx: [1],
  silenceFrames: 6,
  gapCapsMs: { '2': 100 },
  transcriptPlayOrder: [0, 2, 1],
};

const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [],
  items: [clip],
  trackOrder: ['A1'],
  tracks: { A1: { kind: 'audio' } },
}));

const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const before = draft.getState().items[0]!;
assert.equal((before.deletedWordIdx ?? []).length, 1);
assert.equal(before.silenceFrames, 6);

const result = await execTranscriptTool(
  'manage_transcript',
  { action: 'clear_edits', itemId: 'clip_v' },
  ctx,
) as {
  ok?: boolean;
  action?: string;
  itemId?: string;
  restored?: { deletedWords: number; gapOverrides: number; silenceCap: boolean; playOrder: boolean };
  durationInFrames?: number;
};

assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.action, 'clear_edits');
assert.equal(result.itemId, 'clip_voice');
assert.equal(result.restored?.deletedWords, 1);
assert.equal(result.restored?.gapOverrides, 1);
assert.equal(result.restored?.silenceCap, true);
assert.equal(result.restored?.playOrder, true);

const after = draft.getState().items[0]!;
assert.deepEqual(after.deletedWordIdx, []);
assert.equal(after.silenceFrames, undefined);
assert.equal(after.gapCapsMs, undefined);
assert.equal(after.transcriptPlayOrder, undefined);
assert.equal(after.transcript?.length, 3);
assert.ok(typeof result.durationInFrames === 'number' && result.durationInFrames > 0);

// Idempotent second clear.
const again = await execTranscriptTool(
  'manage_transcript',
  { action: 'clear_edits', track: 'A1' },
  ctx,
) as { ok?: boolean; restored?: { deletedWords: number } };
assert.equal(again.ok, true);
assert.equal(again.restored?.deletedWords, 0);

console.log('transcript-clear-edits.verify: ok');
