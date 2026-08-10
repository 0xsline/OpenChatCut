// split_item: transcript/deleted/variant/gapCap partition with word/frame alignment + fade
// placement. Pure splitClipTranscript + reduce 'split' end-to-end. npx tsx src/editor/split.check.ts
import assert from 'node:assert/strict';
import { reduce } from './reduce';
import { splitClipTranscript } from '../transcript/edit';
import type { TimelineItem, TimelineState } from './types';
import type { TranscriptWord } from '../transcript/types';

const fps = 30;
// 4 words @30fps: a[f0-27] b[f30-57] c[f60-87] d[f90-117]
const W: TranscriptWord[] = [
  { text: 'a', start: 0, end: 900 },
  { text: 'b', start: 1000, end: 1900 },
  { text: 'c', start: 2000, end: 2900 },
  { text: 'd', start: 3000, end: 3900 },
];

// ── pure splitClipTranscript ────────────────────────────────────────────────
assert.equal(splitClipTranscript({}, fps, 45), null, 'no transcript → null');
assert.equal(splitClipTranscript({ transcript: [] }, fps, 45), null, 'empty transcript → null');

{ // unedited: cut 45 → source frame 45 → boundary before c → k=2
  const r = splitClipTranscript({ transcript: W }, fps, 45)!;
  assert.equal(r.k, 2);
  assert.deepEqual(r.left.transcript!.map((w) => w.text), ['a', 'b']);
  assert.deepEqual(r.right.transcript!.map((w) => w.text), ['c', 'd']);
  assert.deepEqual(r.left.deletedWordIdx, []);
  assert.deepEqual(r.right.deletedWordIdx, []);
}
assert.equal(splitClipTranscript({ transcript: W }, fps, 75)!.k, 3, 'later cut → k=3');
assert.equal(splitClipTranscript({ transcript: W }, fps, 5)!.k, 1, 'word straddling the cut stays left');
assert.equal(splitClipTranscript({ transcript: W }, fps, 500)!.k, 4, 'cut past all words → all left');

{ // deleted word in the right half → reindex to i-k (delete c=2, early cut k=1)
  const r = splitClipTranscript({ transcript: W, deletedWordIdx: [2] }, fps, 5)!;
  assert.equal(r.k, 1);
  assert.deepEqual(r.left.deletedWordIdx, []);
  assert.deepEqual(r.right.deletedWordIdx, [1], 'c: source idx 2 → right idx 1');
}
{ // deletion-aware boundary: b deleted compresses the edited timeline, so edited-cut 40
  // maps to source frame 73 (inside c) → k=3, not the naive k=2
  const r = splitClipTranscript({ transcript: W, deletedWordIdx: [1] }, fps, 40)!;
  assert.equal(r.k, 3);
  assert.deepEqual(r.left.deletedWordIdx, [1], 'b still deleted in left');
  assert.deepEqual(r.right.deletedWordIdx, []);
}
{ // variants partition + rebase by source index (k=2)
  const variants = [{ id: 'v1', lang: 'en', kind: 'translation' as const, label: 'EN', words: [{ i: 0, text: 'A' }, { i: 2, text: 'C' }, { i: 3, text: 'D' }] }];
  const r = splitClipTranscript({ transcript: W, variants }, fps, 45)!;
  assert.deepEqual(r.left.variants![0]!.words, [{ i: 0, text: 'A' }], 'left variant word i<k');
  assert.deepEqual(r.right.variants![0]!.words, [{ i: 0, text: 'C' }, { i: 1, text: 'D' }], 'right variant rebased i-k');
}
{ // gapCaps: left keeps keys<k, boundary key=k dropped, right rebased key-k (k=2)
  const r = splitClipTranscript({ transcript: W, gapCapsMs: { '1': 100, '2': 0, '3': 200 } }, fps, 45)!;
  assert.deepEqual(r.left.gapCapsMs, { '1': 100 });
  assert.deepEqual(r.right.gapCapsMs, { '1': 200 }, 'key3→1; boundary key2 dropped');
}

// ── reduce 'split' end-to-end: fades on outer edges only + partition wiring ──
const item = (over: Partial<TimelineItem>): TimelineItem =>
  ({ id: 'v1', track: 'V1', startFrame: 0, durationInFrames: 117, kind: 'video', name: 'clip', src: '/m.mp4', ...over });
const stateOf = (it: TimelineItem): TimelineState => ({ fps, width: 1920, height: 1080, selectedId: null, items: [it] });

{ // transcript clip: partitioned words, fades on the outer edges only
  const out = reduce(stateOf(item({ transcript: W, fadeInFrames: 6, fadeOutFrames: 9 })), { type: 'split', id: 'v1', atFrame: 45, newId: 'v1b' });
  assert.equal(out.items.length, 2, 'split → 2 items');
  const left = out.items.find((x) => x.id === 'v1')!;
  const right = out.items.find((x) => x.id === 'v1b')!;
  assert.deepEqual(left.transcript!.map((w) => w.text), ['a', 'b'], 'left half words');
  assert.deepEqual(right.transcript!.map((w) => w.text), ['c', 'd'], 'right half words (no longer the whole list)');
  assert.equal(left.durationInFrames, 45, 'left dur = cut');
  assert.equal(right.durationInFrames, 72, 'right dur = remainder');
  assert.equal(right.srcInFrame, 45, 'right srcIn advanced by cut');
  assert.equal(left.fadeInFrames, 6, 'left keeps fadeIn (its IN is the real clip start)');
  assert.equal(left.fadeOutFrames, undefined, 'left drops fadeOut (its OUT is now the mid-clip cut)');
  assert.equal(right.fadeInFrames, undefined, 'right drops fadeIn (its IN is now the mid-clip cut)');
  assert.equal(right.fadeOutFrames, 9, 'right keeps fadeOut (its OUT is the real clip end)');
}
{ // non-transcript clip: still splits, fades still land on outer edges
  const out = reduce(stateOf(item({ transcript: undefined, fadeInFrames: 6, fadeOutFrames: 9 })), { type: 'split', id: 'v1', atFrame: 45, newId: 'v1b' });
  assert.equal(out.items.length, 2);
  assert.equal(out.items.find((x) => x.id === 'v1')!.fadeOutFrames, undefined, 'no-transcript left drops fadeOut');
  assert.equal(out.items.find((x) => x.id === 'v1b')!.fadeInFrames, undefined, 'no-transcript right drops fadeIn');
  assert.equal(out.items.find((x) => x.id === 'v1b')!.transcript, undefined, 'no transcript to partition');
}

console.log('split.check: OK');
