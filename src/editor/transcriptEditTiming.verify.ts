// Transcript/word-edit timing: a word op must never re-time a CONTINUOUS clip, a split
// must partition the transcript in the clip's own coordinate space, and a speed change
// must round-trip to the original cut. Reducer-level, deterministic.
// npx tsx src/editor/transcriptEditTiming.verify.ts
import assert from 'node:assert/strict';
import { reduce } from './reduce';
import { mediaWindowWords } from '../transcript/edit';
import { sourceSpanForSpeed } from './sourceLimit';
import type { TimelineItem, TimelineState } from './types';
import type { TranscriptWord } from '../transcript/types';

const fps = 30;
// 10 words, one per second, 900 ms long: wN starts at source frame N*30.
const words = (n: number): TranscriptWord[] =>
  Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: i * 1000, end: i * 1000 + 900 }));

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  id: 'v', track: 'V1', startFrame: 0, durationInFrames: 300, kind: 'video',
  name: 'v', src: 'x', ...over,
});
const stateOf = (items: TimelineItem[]): TimelineState => ({
  fps, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V1', 'A1'],
  tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items,
});
const byId = (s: TimelineState, id: string): TimelineItem => s.items.find((it) => it.id === id)!;
const txt = (it: TimelineItem): string => (it.transcript ?? []).map((w) => w.text).join(',');
const captionText = (it: TimelineItem): string =>
  mediaWindowWords(it.transcript ?? [], fps, it).map((w) => w.text).join(',');

// ── BUG 1: word edits must not re-time a video clip ─────────────────────────
// A video renders its source continuously (one RuntimeVideo, trimBefore = sourceFrameAt);
// its word stream is not its render, so deriving durationInFrames from it trimmed the
// tail of the picture instead of the edited word's span.
{
  // clean_script (the 停顿 button) with no fillers and no silence cap used to take
  // 300 → 222 frames: 2.6 s of picture lost, no ripple, no hole filled.
  const s = stateOf([item({ transcript: [{ text: 'hello', start: 500, end: 900 }, { text: 'world', start: 1000, end: 7900 }] })]);
  const out = reduce(s, { type: 'cleanScript', id: 'v', removeFillers: false });
  assert.equal(byId(out, 'v').durationInFrames, 300, 'video clean_script keeps the clip length');
  assert.equal(byId(out, 'v').srcInFrame ?? 0, 0, 'video srcInFrame untouched (media frames, not the word window)');
}
{
  // The 停顿 button sends a silence cap (`silenceFrames`) — the exact UI trigger that
  // silently cut the tail. A video's pauses are not removed from its picture, so neither
  // is its length; the cap is still recorded for the transcript/caption layers.
  const s = stateOf([item({ transcript: words(10) })]);
  const out = reduce(s, { type: 'cleanScript', id: 'v', removeFillers: true, silenceFrames: 4 });
  assert.equal(byId(out, 'v').durationInFrames, 300, 'video 停顿/silence cap keeps the clip length');
  assert.equal(byId(out, 'v').silenceFrames, 4, 'the cap itself is still recorded on the clip');
}
{
  // Deleting a word used to take 300 → 264. The evidence a user hears/sees is the same
  // clip; only the transcript bookkeeping changes.
  const s = stateOf([item({ transcript: words(10) })]);
  const out = reduce(s, { type: 'toggleWord', id: 'v', idx: 2 });
  const v = byId(out, 'v');
  assert.equal(v.durationInFrames, 300, 'video word delete keeps the clip length');
  assert.deepEqual(v.deletedWordIdx, [2], 'the word is still recorded as deleted');
  assert.equal(captionText(v), 'w0,w1,w2,w3,w4,w5,w6,w7,w8,w9',
    'video captions still project every word of the continuous window (deleted word stays audible)');
  // clear_edits restores the flag without changing the slot either way.
  assert.equal(byId(reduce(out, { type: 'clearEdits', id: 'v' }), 'v').durationInFrames, 300,
    'video clear_edits keeps the clip length');
  assert.deepEqual(byId(reduce(out, { type: 'clearEdits', id: 'v' }), 'v').deletedWordIdx, [], 'clear_edits clears the deletions');
}
{
  // Audio is the word-driven path and must stay byte-identical: same clip, audio track.
  const s = stateOf([item({ id: 'a', track: 'A1', kind: 'audio', transcript: words(10) })]);
  assert.equal(byId(reduce(s, { type: 'toggleWord', id: 'a', idx: 2 }), 'a').durationInFrames, 264,
    'audio word delete still shrinks (unchanged)');
  const cleaned = reduce(stateOf([item({ id: 'a', track: 'A1', kind: 'audio', transcript: words(10) })]),
    { type: 'cleanScript', id: 'a', removeFillers: false, silenceFrames: 4 });
  assert.ok(byId(cleaned, 'a').durationInFrames < 300, 'audio clean_script with a silence cap still shrinks (unchanged)');
}

// ── BUG 2: split of a clip with deleted words keeps both halves' captions ───
// The cut is computed in whichever space the clip renders in. A video cut is an
// absolute MEDIA frame; mapping it through the edited (deletion-compressed) stream
// landed the partition too far right and dropped w4/w5 from both halves.
{
  const s = reduce(stateOf([item({ transcript: words(10) })]), { type: 'toggleWord', id: 'v', idx: 2 });
  const split = reduce(s, { type: 'split', id: 'v', atFrame: 120, newId: 'v2' });
  const left = byId(split, 'v');
  const right = byId(split, 'v2');
  assert.deepEqual([left.durationInFrames, right.durationInFrames], [120, 180], 'a split still tiles the clip exactly');
  assert.equal(txt(left), 'w0,w1,w2,w3', 'left keeps the words starting before the media cut');
  assert.equal(txt(right), 'w4,w5,w6,w7,w8,w9', 'right keeps the words after it');
  assert.equal(captionText(left), 'w0,w1,w2,w3', 'left half renders its own captions');
  assert.equal(captionText(right), 'w4,w5,w6,w7,w8,w9', 'right half renders its own captions — no word loses its cue');
  assert.deepEqual(left.deletedWordIdx, [2], 'the deleted word stays deleted on the half that owns it');
}
{
  // Word-driven audio still partitions through the EDITED stream (this is the case the
  // old mapping existed for): 4 words a..d, b deleted, cut at edited frame 40 → k=3.
  const W: TranscriptWord[] = [
    { text: 'a', start: 0, end: 900 }, { text: 'b', start: 1000, end: 1900 },
    { text: 'c', start: 2000, end: 2900 }, { text: 'd', start: 3000, end: 3900 },
  ];
  const s = reduce(stateOf([item({ id: 'a', track: 'A1', kind: 'audio', durationInFrames: 117, transcript: W })]),
    { type: 'toggleWord', id: 'a', idx: 1 });
  assert.equal(byId(s, 'a').durationInFrames, 84, 'audio edit state: 117 → 84 after deleting b');
  const split = reduce(s, { type: 'split', id: 'a', atFrame: 40, newId: 'a2' });
  assert.equal(txt(byId(split, 'a')), 'a,b,c', 'audio left half unchanged');
  assert.equal(txt(byId(split, 'a2')), 'd', 'audio right half unchanged — the edited-stream mapping is kept');
  assert.equal(byId(split, 'a2').srcInFrame, 0, 'word-driven right half still restarts its own word stream');
}

// ── BUG 3: a speed change must round-trip to the original cut ───────────────
{
  // One slider sweep up and back used to leave 93 frames (neighbour pushed to 93)
  // because every step re-derived the span from the already-rounded duration.
  let s = stateOf([item({ id: 'a', startFrame: 0, durationInFrames: 90 }), item({ id: 'b', startFrame: 90, durationInFrames: 60 })]);
  const up: number[] = []; for (let i = 21; i <= 80; i++) up.push(i / 20);
  const down: number[] = []; for (let i = 80; i >= 20; i--) down.push(i / 20);
  for (const rate of [...up, ...down]) s = reduce(s, { type: 'setSpeed', id: 'a', rate });
  assert.equal(byId(s, 'a').durationInFrames, 90, 'sweep 1x→4x→1x returns the original 90 frames');
  assert.equal(byId(s, 'a').playbackRate, 1);
  assert.equal(sourceSpanForSpeed(byId(s, 'a')), 90, 'the source span is exactly the original 90 source frames');
  assert.equal(byId(s, 'b').startFrame, 90, 'the neighbour is back where it started (no +3 frame push)');
}
{
  let s = stateOf([item({ id: 'a', durationInFrames: 90 }), item({ id: 'b', startFrame: 90, durationInFrames: 60 })]);
  s = reduce(s, { type: 'setSpeed', id: 'a', rate: 4 });
  assert.equal(byId(s, 'a').durationInFrames, 23, '4x of a 90-frame span is 22.5 → 23 timeline frames');
  assert.equal(byId(s, 'a').speedSpan, 90, 'the exact span is remembered across the change');
  s = reduce(s, { type: 'setSpeed', id: 'a', rate: 1 });
  assert.equal(byId(s, 'a').durationInFrames, 90, '1x→4x→1x is exact (used to give 92)');
}
{
  let s = stateOf([item({ id: 'a', durationInFrames: 90 }), item({ id: 'b', startFrame: 90, durationInFrames: 60 })]);
  s = reduce(s, { type: 'setSpeed', id: 'a', rate: 1.2 });
  s = reduce(s, { type: 'setSpeed', id: 'a', rate: 1 });
  assert.equal(byId(s, 'a').durationInFrames, 90, '1x→1.2x→1x is exact');
  assert.equal(byId(s, 'b').startFrame, 90, 'neighbour unmoved');
}
{
  // A trim between two speed steps must invalidate the remembered span, not resurrect it.
  let s = stateOf([item({ id: 'a', durationInFrames: 90 })]);
  s = reduce(s, { type: 'setSpeed', id: 'a', rate: 2 });
  assert.equal(byId(s, 'a').durationInFrames, 45);
  s = reduce(s, { type: 'retime', id: 'a', durationInFrames: 30 });
  assert.equal(sourceSpanForSpeed(byId(s, 'a')), 60, 'the trimmed span (30 frames at 2x) wins over the stale 90');
  s = reduce(s, { type: 'setSpeed', id: 'a', rate: 1 });
  assert.equal(byId(s, 'a').durationInFrames, 60, '1x of the trimmed 60-frame span — not the pre-trim 90');
}

console.log('transcriptEditTiming.verify: OK');
