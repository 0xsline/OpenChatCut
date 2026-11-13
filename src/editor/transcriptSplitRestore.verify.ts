// Split-with-reorder + word-restore: the split of a speech-block-reordered audio clip must
// partition IN THE PLAYED STREAM (each half keeps its own play order and source spans), and
// restoring a word at a packed seam must ripple followers instead of being silently dropped.
// Reducer-level, deterministic.
// npx tsx src/editor/transcriptSplitRestore.verify.ts
import assert from 'node:assert/strict';
import { reduce } from './reduce';
import { keptSegments } from '../transcript/edit';
import type { TimelineItem, TimelineState } from './types';
import type { TranscriptWord } from '../transcript/types';

const fps = 30;
// 10 words, one per second, 900 ms long: wN starts at source frame N*30.
const words = (n: number): TranscriptWord[] =>
  Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: i * 1000, end: i * 1000 + 900 }));

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  id: 'a', track: 'A1', startFrame: 0, durationInFrames: 297, kind: 'audio',
  name: 'a', src: 'x', ...over,
});
const stateOf = (items: TimelineItem[]): TimelineState => ({
  fps, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V1', 'A1'],
  tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items,
});
const byId = (s: TimelineState, id: string): TimelineItem => s.items.find((it) => it.id === id)!;
const txt = (it: TimelineItem): string => (it.transcript ?? []).map((w) => w.text).join(',');

/** The source spans an audio clip actually renders: its kept stream windowed to its trim. */
const renderedSpans = (it: TimelineItem): string =>
  keptSegments(it.transcript ?? [], new Set(it.deletedWordIdx ?? []), fps, 0,
    {
      playOrder: it.transcriptPlayOrder,
      maxGapFrames: it.silenceFrames,
      gapCapsMs: it.gapCapsMs,
      window: { startFrame: it.srcInFrame ?? 0, durFrames: it.durationInFrames },
    })
    .map((seg) => `${seg.srcStartFrame}-${seg.srcEndFrame}`).join(' ');

// ── BUG 4: splitting a speech-block-reordered clip must keep the reordered audio ──────
// 10 words, playOrder = [5,6,7,0,1,2,3,4,8,9], split at frame 120. The rendered stream is
// 150-237, 0-147, 240-297 (291 frames); the first 120 frames of it are 150-237 + 0-33 and
// the remaining 171 are 33-147 + 240-297. Before the fix the halves played 0-117 / 120-291
// (chronological audio replacing the reordered blocks; totals still added up, so the UI
// showed nothing wrong).
{
  const s = stateOf([item({ durationInFrames: 291, transcript: words(10), transcriptPlayOrder: [5, 6, 7, 0, 1, 2, 3, 4, 8, 9] })]);
  const out = reduce(s, { type: 'split', id: 'a', atFrame: 120, newId: 'a2' });
  const left = byId(out, 'a');
  const right = byId(out, 'a2');
  assert.deepEqual([left.durationInFrames, right.durationInFrames], [120, 171], 'a split still tiles the clip exactly');
  assert.equal(left.durationInFrames + right.durationInFrames, 291, 'halves frame sum matches the original clip');
  assert.equal(renderedSpans(left), '150-237 0-33', 'left half plays the first 120 frames of the REORDERED stream');
  assert.equal(renderedSpans(right), '33-147 240-297', 'right half plays the remaining 171 frames of the REORDERED stream');
  assert.deepEqual(left.transcriptPlayOrder, [5, 6, 7, 0, 1], 'left half re-encodes its slice of the play order');
  assert.deepEqual(right.transcriptPlayOrder, [0, 1, 2, 3, 7, 8], 'right half re-encodes its slice of the play order');
}
{
  // Splits that land on a word boundary still partition in the played stream; a half whose
  // source slice IS exactly its played set collapses to chronological (undefined order).
  const s = stateOf([item({ durationInFrames: 291, transcript: words(10), transcriptPlayOrder: [5, 6, 7, 0, 1, 2, 3, 4, 8, 9] })]);
  const out = reduce(s, { type: 'split', id: 'a', atFrame: 87, newId: 'a2' }); // w5..w7 end at 87
  assert.equal(renderedSpans(byId(out, 'a')), '150-237', 'left = the w5..w7 block');
  assert.equal(renderedSpans(byId(out, 'a2')), '0-147 240-297', 'right = the rest of the reordered stream');
  assert.deepEqual(byId(out, 'a').transcriptPlayOrder, [5, 6, 7], 'left keeps its (non-identity) order');
  assert.equal(byId(out, 'a').srcInFrame, 0, 'word-aligned cut needs no window trim');
}
{
  // The played set of a half can be exactly its source slice: then the order is identity and
  // collapses to undefined — byte-identical when replayed (w8..w9 after the w0..w4 block).
  const s = stateOf([item({ durationInFrames: 291, transcript: words(10), transcriptPlayOrder: [5, 6, 7, 0, 1, 2, 3, 4, 8, 9] })]);
  const out = reduce(s, { type: 'split', id: 'a', atFrame: 234, newId: 'a2' }); // w0..w4 end at 234
  assert.equal(renderedSpans(byId(out, 'a')), '150-237 0-147', 'left = first reordered block + middle block');
  assert.equal(renderedSpans(byId(out, 'a2')), '240-297', 'right = exactly w8..w9');
  assert.equal(byId(out, 'a2').transcriptPlayOrder, undefined, 'identity order collapses to chronological');
  assert.equal(byId(out, 'a2').srcInFrame, 0, 'word-aligned cut needs no window trim');
}

// ── no-playOrder split path is byte-identical ─────────────────────────────────────────
{
  // Classic word-driven audio split at 120: the cut maps through the EDITED stream (w0
  // deleted → boundary lands at source 150), so left = w0..w4, right = w5..w9.
  const s = stateOf([item({ durationInFrames: 270, deletedWordIdx: [0], transcript: words(10) })]);
  const out = reduce(s, { type: 'split', id: 'a', atFrame: 120, newId: 'a2' });
  assert.deepEqual([byId(out, 'a').durationInFrames, byId(out, 'a2').durationInFrames], [120, 150]);
  assert.equal(txt(byId(out, 'a')), 'w0,w1,w2,w3,w4', 'left = words before the edited-stream cut (unchanged partition)');
  assert.deepEqual(byId(out, 'a').deletedWordIdx, [0], 'left keeps the deletion state (word 0 deleted)');
  assert.equal(txt(byId(out, 'a2')), 'w5,w6,w7,w8,w9', 'right = words after the edited-stream cut (unchanged partition)');
  assert.deepEqual(byId(out, 'a2').deletedWordIdx, [], 'right has no deletions');
  assert.equal(byId(out, 'a').transcriptPlayOrder, undefined);
  assert.equal(byId(out, 'a2').transcriptPlayOrder, undefined);
  assert.equal(byId(out, 'a2').srcInFrame, 0, 'classic right half restarts its own edited stream');
}
{
  // An EXPLICIT identity play order is a non-reorder in disguise and must behave like the
  // classic split (not shift the partition).
  const s = stateOf([item({ durationInFrames: 291, transcript: words(10), transcriptPlayOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })]);
  const out = reduce(s, { type: 'split', id: 'a', atFrame: 120, newId: 'a2' });
  assert.equal(renderedSpans(byId(out, 'a')), '0-117', 'identity order: left is the chronological head, as before');
  assert.equal(renderedSpans(byId(out, 'a2')), '120-291', 'identity order: right is the chronological tail, as before');
}

// ── BUG 5: restoring a word at a packed seam ripples followers instead of silent no-op ─
// The clip grows from 270 back to 297 frames; the follower butt-joined at 270 must be
// pushed to 297 — the same ripple `setSpeed` performs via contiguousFollowers. Before the
// fix the overlap guard discarded the whole action: reduce() returned the identical state.
{
  const a = item({ durationInFrames: 270, deletedWordIdx: [0], transcript: words(10) });
  const b = { ...item({ id: 'b', startFrame: 270, durationInFrames: 60 }), transcript: undefined, deletedWordIdx: undefined };
  const s = stateOf([a, b]);
  const out = reduce(s, { type: 'toggleWord', id: 'a', idx: 0 });
  assert.notEqual(out, s, 'the restore must no longer be silently rejected');
  assert.equal(byId(out, 'a').durationInFrames, 297, 'word restored, duration back to the full stream');
  assert.deepEqual(byId(out, 'a').deletedWordIdx, [], 'deletion cleared');
  assert.equal(byId(out, 'b').startFrame, 297, 'butt-joined follower pushed by the growth delta (27 frames)');
}
{
  // With room ahead of the follower nothing needed rippling and nothing moved.
  const a = item({ durationInFrames: 270, deletedWordIdx: [0], transcript: words(10) });
  const b = { ...item({ id: 'b', startFrame: 400, durationInFrames: 60 }), transcript: undefined, deletedWordIdx: undefined };
  const out = reduce(stateOf([a, b]), { type: 'toggleWord', id: 'a', idx: 0 });
  assert.equal(byId(out, 'a').durationInFrames, 297, 'with room the restore always applied');
  assert.equal(byId(out, 'b').startFrame, 400, 'gap boundary respected — the follower is not dragged');
}
{
  // clearEdits takes the same ripple path.
  const a = item({ durationInFrames: 270, deletedWordIdx: [0], transcript: words(10) });
  const b = { ...item({ id: 'b', startFrame: 270, durationInFrames: 60 }), transcript: undefined, deletedWordIdx: undefined };
  const out = reduce(stateOf([a, b]), { type: 'clearEdits', id: 'a' });
  assert.notEqual(out, undefined, 'clearEdits is not discarded at a packed seam');
  assert.equal(byId(out, 'a').durationInFrames, 297);
  assert.equal(byId(out, 'b').startFrame, 297, 'clearEdits ripples the same as toggleWord');
}
{
  // The SHRINK path is untouched: deleting a word leaves the vacated gap (the follower is
  // NOT pulled left), preserving the pre-existing behaviour byte-for-byte.
  const a = item({ durationInFrames: 297, transcript: words(10) });
  const b = { ...item({ id: 'b', startFrame: 297, durationInFrames: 60 }), transcript: undefined, deletedWordIdx: undefined };
  const out = reduce(stateOf([a, b]), { type: 'toggleWord', id: 'a', idx: 0 });
  assert.equal(byId(out, 'a').durationInFrames, 267, 'deleting word 0 shortens the stream to 267');
  assert.equal(byId(out, 'b').startFrame, 297, 'shortening must not drag the follower (gap opens, as before)');
}

console.log('transcriptSplitRestore.verify: OK');