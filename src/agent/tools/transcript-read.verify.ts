import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import type { TimelineState } from '../../editor/types';
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

console.log('transcript read checks passed');
