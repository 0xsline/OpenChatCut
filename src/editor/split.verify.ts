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

{
  const base = stateOf(item({}));
  assert.equal(reduce(base, { type: 'split', id: 'v1', atFrame: Number.NaN, newId: 'v1b' }).items.length, 1,
    'NaN split positions are rejected');
  assert.equal(reduce(base, { type: 'split', id: 'v1', atFrame: 45, newId: 'v1' }).items.length, 1,
    'split ids must not collide with existing items');
  assert.equal(reduce(base, { type: 'duplicate', id: 'v1', newId: 'v1' }).items.length, 1,
    'duplicate ids must not collide with existing items');
  const { startFrame: _startFrame, ...newItem } = item({ id: 'v2' });
  assert.equal(reduce(base, { type: 'add', item: newItem, startFrame: Number.NaN }).items.length, 1,
    'NaN add positions are rejected');
  assert.equal(reduce(base, { type: 'retime', id: 'v1', durationInFrames: Number.NaN }).items[0]!.durationInFrames, 117,
    'NaN retime values are rejected');
}

// ── motion graphic: the pieces are windows of ONE animation, never restarts ──
// Asking the agent to "separate this MG into several" used to regenerate every piece from scratch,
// because splitting made the right piece replay the intro. Split pieces now keep the whole design.
{
  const mg = (over: Partial<TimelineItem>): TimelineItem => ({
    id: 'mg', track: 'V4', startFrame: 4514, durationInFrames: 868, kind: 'motion-graphic',
    name: 'AI1.5 Multimodal Motion Suite', code: 'const C = ({ item }) => null;', ...over,
  });
  let s = reduce(stateOf(mg({})), { type: 'split', id: 'mg', atFrame: 4674, newId: 'mg2' });
  const [a, b] = s.items;
  assert.equal(a!.srcInFrame ?? 0, 0, 'the first piece still starts the animation at its beginning');
  assert.equal(b!.srcInFrame, 160, 'the second piece continues from the frame at the cut, not the intro');
  assert.equal(a!.designDurationInFrames, 868, 'both pieces remember the whole design');
  assert.equal(b!.designDurationInFrames, 868);
  assert.equal(b!.code, a!.code, 'the same design, not a regenerated one');

  // Split again (4 beats): offsets accumulate and the design length stays the original.
  s = reduce(s, { type: 'split', id: 'mg2', atFrame: 4864, newId: 'mg3' });
  s = reduce(s, { type: 'split', id: 'mg3', atFrame: 5094, newId: 'mg4' });
  const pieces = [...s.items].sort((x, y) => x.startFrame - y.startFrame);
  assert.deepEqual(pieces.map((p) => [p.startFrame, p.durationInFrames, p.srcInFrame ?? 0]),
    [[4514, 160, 0], [4674, 190, 160], [4864, 230, 350], [5094, 288, 580]],
    'four pieces tile the original animation with no gap and no replay');
  assert.ok(pieces.every((p) => p.designDurationInFrames === 868), 'every piece plays a window of the same 868 frames');

  // Trimming a piece trims its window of the animation, like video. (The timeline's left handle now moves
  // srcInFrame for a split piece; before, the piece just started later and the animation paused.)
  const { isWindowedMotionGraphic } = await import('./motionGraphicTime');
  const { remainingSourceFrames } = await import('./sourceLimit');
  const third = pieces[2]!;
  assert.equal(isWindowedMotionGraphic(third), true, 'a split piece trims like video');
  assert.equal(isWindowedMotionGraphic(mg({})), false, 'an unsplit MG keeps its old free trimming');
  assert.equal(remainingSourceFrames(third, third.srcInFrame!, []), 868 - 350,
    'its end can reach the end of the design and no further');
  const trimmed = reduce(s, { type: 'retime', id: third.id, startFrame: 4894, durationInFrames: 200, srcInFrame: 380 });
  const t = trimmed.items.find((it) => it.id === third.id)!;
  assert.deepEqual([t.startFrame, t.durationInFrames, t.srcInFrame], [4894, 200, 380], 'start trim cuts 30 frames into its window');
  const overlong = reduce(s, { type: 'retime', id: pieces[3]!.id, durationInFrames: 5000 });
  assert.equal(overlong.items.find((it) => it.id === pieces[3]!.id)!.durationInFrames, 868 - 580,
    'the last piece cannot be stretched past the end of the animation');

  // An unsplit motion graphic is untouched: no design length, plays from frame 0 as before.
  assert.equal(mg({}).designDurationInFrames, undefined);
  // And a video split is unchanged by this.
  const v = reduce(stateOf(item({})), { type: 'split', id: 'v1', atFrame: 45, newId: 'v1b' });
  assert.equal(v.items[1]!.designDurationInFrames, undefined, 'only motion graphics carry a design length');
}

console.log('split.check: OK');
