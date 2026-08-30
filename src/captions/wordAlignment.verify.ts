// Word ↔ index ↔ ref positional alignment under transcriptPlayOrder (speech
// reorder): resolveCaptionWords sorts by timeline start while indices/refs used
// to enumerate in source order — hiding/overriding word N then hit a DIFFERENT
// word. Also covers wordTimelineFrame (word-click seek projection).
// npx tsx src/captions/wordAlignment.verify.ts
import assert from 'node:assert/strict';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { keptWordIndices, retimeWords, wordTimelineFrame } from '../transcript/edit';
import { resolveCaptionWordIndices, resolveCaptionWordRefs, resolveCaptionWords } from './resolve';

const fps = 30;
// 4 words, 1s each, back to back: A[0-1s] B[1-2s] C[2-3s] D[3-4s]
const W: TranscriptWord[] = [
  { id: 'w0', text: 'A', start: 0, end: 1000 },
  { id: 'w1', text: 'B', start: 1000, end: 2000 },
  { id: 'w2', text: 'C', start: 2000, end: 3000 },
  { id: 'w3', text: 'D', start: 3000, end: 4000 },
];
const encodeWordRef = (scope: readonly string[], generationId: string, wordId: string): string =>
  `cw2.${encodeURIComponent(JSON.stringify([...scope, generationId, wordId]))}`;

// ── edit 层:retimeWords 与 keptWordIndices 在 playOrder 下位置对齐 ─────────
{
  const playOrder = [2, 3, 0, 1]; // C D A B
  const words = retimeWords(W, new Set(), fps, 0, { playOrder });
  const indices = keptWordIndices(W, new Set(), fps, { playOrder });
  assert.deepEqual(words.map((w) => w.text), ['C', 'D', 'A', 'B'], 'timeline order follows playOrder');
  assert.deepEqual(indices, [2, 3, 0, 1], 'indices are emitted in the SAME timeline order');
  for (let i = 0; i < words.length; i++) {
    assert.equal(words[i]!.text, W[indices[i]!]!.text, `position ${i}: word ↔ source index aligned`);
  }
  console.log('retimeWords/keptWordIndices alignment: OK');
}

// ── resolve 层:单源音频 + playOrder,words/indices/refs 三方按位对齐 ────────
{
  const item = {
    id: 'clip1', track: 'A1', startFrame: 0, durationInFrames: 120, kind: 'audio',
    name: 'vo', src: '/a.mp3', transcript: W, transcriptGenerationId: 'gen1',
    transcriptPlayOrder: [2, 3, 0, 1],
  } as unknown as TimelineItem;
  const captions = { template: 'plain', sourceItemId: 'clip1' } as never;
  const words = resolveCaptionWords(captions, [item], fps);
  const indices = resolveCaptionWordIndices(captions, [item], fps);
  const refs = resolveCaptionWordRefs(captions, [item], fps);
  assert.equal(words.length, 4);
  assert.equal(indices.length, 4);
  assert.equal(refs.length, 4);
  assert.deepEqual(words.map((w) => w.text), ['C', 'D', 'A', 'B']);
  for (let i = 0; i < words.length; i++) {
    const sourceWord = W[indices[i]!]!;
    assert.equal(words[i]!.text, sourceWord.text, `position ${i}: word ↔ index aligned`);
    assert.equal(refs[i], encodeWordRef(['item', 'clip1'], 'gen1', sourceWord.id!),
      `position ${i}: ref encodes the SAME source word`);
  }
  console.log('resolveCaptionWords/Indices/Refs alignment: OK');
}

// ── wordTimelineFrame:音频删词流投影 ───────────────────────────────────────
{
  const item = {
    id: 'clip1', track: 'A1', startFrame: 100, durationInFrames: 60, kind: 'audio',
    name: 'vo', src: '/a.mp3', transcript: W.slice(0, 3), deletedWordIdx: [1],
  } as unknown as TimelineItem;
  // kept: A[src 0-30)@local 0, C[src 60-90)@local 30
  assert.equal(wordTimelineFrame(item, W[0]!, fps), 100, 'first word seeks to clip head');
  assert.equal(wordTimelineFrame(item, W[2]!, fps), 130,
    'word after a deletion seeks to its EDITED position (not source position)');
  assert.equal(wordTimelineFrame(item, W[1]!, fps), 130,
    'deleted word at a cut seeks to the cut point where playback resumes');
  // 与渲染层一致:retimeWords 的 start 换算成帧应与 seek 目标一致
  const projected = retimeWords(W.slice(0, 3), new Set([1]), fps, item.startFrame, {});
  assert.equal(Math.round((projected[1]!.start / 1000) * fps), 130, 'seek matches render projection');
  console.log('wordTimelineFrame audio: OK');
}

// ── wordTimelineFrame:视频窗口 + 变速投影 ─────────────────────────────────
{
  const base = {
    id: 'v1', track: 'V1', startFrame: 10, durationInFrames: 100, kind: 'video',
    name: 'v', src: '/v.mp4', transcript: W, srcInFrame: 50,
  } as unknown as TimelineItem;
  // word C: src 60 frames → 10 + (60-50) = 20
  assert.equal(wordTimelineFrame(base, W[2]!, fps), 20, 'video window offset honored');
  // word A: [0,30) entirely before srcIn window → null
  assert.equal(wordTimelineFrame(base, W[0]!, fps), null, 'word before the trim window is not audible');
  const fast = { ...base, playbackRate: 2 } as TimelineItem;
  // 2×: src 110 frames → local (110-50)/2 = 30 → 10+30 = 40
  assert.equal(wordTimelineFrame(fast, { id: 'x', text: 'X', start: (110 / fps) * 1000, end: (140 / fps) * 1000 }, fps), 40,
    'playbackRate compresses the seek target');
  console.log('wordTimelineFrame video: OK');
}

console.log('\nwordAlignment.verify: ALL PASSED');
