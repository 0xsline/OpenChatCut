import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import type { TimelineState } from '../../editor/types';
import { isFailedToolResult } from '../toolFailure';
import { execReadTranscript } from './transcript-read';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['audio-main', 'video-main'],
  tracks: {
    'audio-main': { kind: 'audio', name: 'A1' },
    'video-main': { kind: 'video', name: 'V1' },
  },
  items: [
    {
      id: 'clip-audio', track: 'audio-main', startFrame: 60, durationInFrames: 60,
      name: 'take one', kind: 'audio', src: '/media/uploads/a.wav',
      transcript: [
        { text: 'Hello', start: 0, end: 200, speaker: 'A' },
        { text: 'skip', start: 220, end: 350, speaker: 'A' },
        { text: 'world', start: 400, end: 700, speaker: 'A' },
      ],
      deletedWordIdx: [1],
    },
    {
      id: 'clip-video', track: 'video-main', startFrame: 150, durationInFrames: 30,
      name: 'take two', kind: 'video', src: '/media/uploads/b.mp4',
      transcript: [{ text: '第二段', start: 0, end: 500, speaker: 'B' }],
    },
  ],
};
const ctx = {
  getState: () => state,
  getDoc: () => ({ assets: [], timelines: [], activeTimelineId: 'timeline' }),
  commands: {}, templates: [], audio: [], getCreativeMode: () => null,
} as unknown as AgentContext;

const all = execReadTranscript({}, ctx) as {
  ok: boolean;
  clips: number;
  phraseCount: number;
  phrases: Array<{ sourceItemId: string; text: string; track: string; fromFrame: number; wordRanges: number[][] }>;
};
assert.equal(all.ok, true);
assert.equal(all.clips, 2, 'reads every transcribed take by default');
assert.equal(all.phraseCount, 2);
assert.equal(all.phrases[0]!.sourceItemId, 'clip-audio');
assert.equal(all.phrases[0]!.text, 'Hello world', 'deleted source words are omitted');
assert.deepEqual(all.phrases[0]!.wordRanges, [[0, 1], [2, 3]], 'source indices remain traceable');
assert.equal(all.phrases[0]!.fromFrame, 60, 'timeline frame mapping uses the shared edit mapper');
assert.equal(all.phrases[1]!.sourceItemId, 'clip-video');

const one = execReadTranscript({ itemId: 'clip-aud', limit: 1 }, ctx) as { clips: number; returned: number; hasMore: boolean };
assert.equal(one.clips, 1, 'item prefix narrows to one take');
assert.equal(one.returned, 1);
assert.equal(one.hasMore, false);

const track = execReadTranscript({ track: 'V1' }, ctx) as { clips: number; phrases: Array<{ sourceItemId: string }> };
assert.equal(track.clips, 1, 'track alias narrows the phrase view');
assert.equal(track.phrases[0]!.sourceItemId, 'clip-video');

const untranscribedState = {
  ...state,
  items: state.items.map((item) => ({ ...item, transcript: undefined })),
};
const unavailable = execReadTranscript(
  { itemId: 'clip-aud' },
  { ...ctx, getState: () => untranscribedState } as AgentContext,
) as { ok: boolean; available: boolean; reason: string; itemId: string; nextAction: string };
assert.deepEqual(
  unavailable,
  {
    ok: true,
    available: false,
    reason: 'not-transcribed',
    itemId: 'clip-audio',
    clips: 0,
    phraseCount: 0,
    returned: 0,
    phrases: [],
    nextAction: 'transcribe_track',
  },
  'an existing clip without a transcript is an availability state, not a failed read',
);
assert.equal(isFailedToolResult(unavailable), false, 'optional transcript discovery must not poison final Agent completion');
assert.match(
  String((execReadTranscript({ itemId: 'missing' }, ctx) as { error: string }).error),
  /no audio\/video item/,
  'a bad item id remains a real tool failure',
);

const staleState = { ...state, items: state.items.map((item) => ({ ...item, transcriptStale: true })) };
for (const args of [{}, { itemId: 'clip-aud' }, { track: 'V1' }]) {
  const stale = execReadTranscript(args, { ...ctx, getState: () => staleState });
  assert.equal(isFailedToolResult(stale), true, 'stale source words remain a failed read in every scope');
  assert.match(String((stale as { error: string }).error), /stale/);
}
const mixedState = { ...state, items: [staleState.items[0]!, untranscribedState.items[1]!] };
assert.equal(
  isFailedToolResult(execReadTranscript({ track: 'V1' }, { ...ctx, getState: () => mixedState })),
  false,
  'stale words on another track do not change an untranscribed track availability',
);

console.log('transcript read checks passed');
