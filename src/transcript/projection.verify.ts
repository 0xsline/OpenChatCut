import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { keptSegments, projectRetimedWords, type EditOpts } from './edit';
import { msToFrame, type TranscriptWord } from './types';
import { wordSegmentLookup } from './wordSegments';

// Characterization oracle: the previous two linear first-match passes, including
// touching boundaries and post-projection de-overlap, intentionally independent.
function reference(words: TranscriptWord[], deleted: Set<number>, fps: number, offset: number, opts: EditOpts = {}) {
  const segments = keptSegments(words, deleted, fps, offset, opts);
  const entries = [];
  for (let i = 0; i < words.length; i++) {
    if (deleted.has(i)) continue;
    const startFrame = msToFrame(words[i].start, fps);
    const endFrame = msToFrame(words[i].end, fps);
    const segment = segments.find((s) => startFrame >= s.srcStartFrame && startFrame < s.srcEndFrame)
      ?? segments.find((s) => startFrame <= s.srcEndFrame && endFrame >= s.srcStartFrame);
    if (!segment) continue;
    const from = segment.fromFrame + Math.max(startFrame, segment.srcStartFrame) - segment.srcStartFrame;
    const to = segment.fromFrame + Math.min(endFrame, segment.srcEndFrame) - segment.srcStartFrame;
    const start = from / fps * 1000;
    entries.push({ index: i, word: { text: words[i].text, start, end: Math.max(start + 1, to / fps * 1000), speaker: words[i].speaker } });
  }
  entries.sort((a, b) => a.word.start - b.word.start);
  for (let index = 1; index < entries.length; index++) {
    const word = entries[index].word;
    word.start = Math.max(word.start, entries[index - 1].word.end);
    if (word.end <= word.start) word.end = word.start + 1;
  }
  return { words: entries.map((entry) => entry.word), indices: entries.map((entry) => entry.index) };
}

let seed = 20260905;
const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
const integer = (n: number) => Math.floor(random() * n);
for (let sample = 0; sample < 800; sample++) {
  const words = Array.from({ length: 1 + integer(80) }, (_, i) => {
    const start = sample % 3 === 0 ? integer(5000) : i * 180 + integer(100);
    return { text: `word-${i}`, start, end: start + integer(350), speaker: i % 2 ? 'A' : null };
  });
  const deleted = new Set(words.flatMap((_, i) => random() < 0.3 ? [i] : []));
  const opts: EditOpts = {
    ...(sample % 4 === 0 ? { playOrder: words.map((_, i) => i).sort(() => random() - 0.5) } : {}),
    ...(sample % 5 === 0 ? { playOrder: words.map(() => integer(words.length + 2) - 1) } : {}),
    ...(sample % 2 === 0 ? { maxGapFrames: integer(6) } : {}),
    ...(sample % 3 === 0 ? { gapCapsMs: { '2': 0, '4': 50, '8': 180 } } : {}),
    ...(sample % 4 !== 0 ? { cutPadFrames: integer(12) } : {}),
    ...(sample % 7 !== 0 ? { window: { startFrame: integer(100), durFrames: integer(200) } } : {}),
  };
  const fps = [24, 30, 60, 23.976][sample % 4];
  const offset = integer(300);
  assert.deepEqual(projectRetimedWords(words, deleted, fps, offset, opts), reference(words, deleted, fps, offset, opts), `sample ${sample}`);
}

// Segment-level edges also include zero-width and touching intervals.
for (const ranges of [[[0, 2], [2, 4]], [[0, 0], [0, 3]], [[5, 9], [0, 4]], [[0, 5], [2, 8]]]) {
  const segments = ranges.map(([start, end], index) => ({ srcStartFrame: start, srcEndFrame: end, fromFrame: index * 10, durFrames: end - start }));
  const lookup = wordSegmentLookup(segments);
  for (let start = -1; start < 10; start++) for (let end = start; end < 11; end++) {
    const expected = segments.find((s) => start >= s.srcStartFrame && start < s.srcEndFrame)
      ?? segments.find((s) => start <= s.srcEndFrame && end >= s.srcStartFrame);
    assert.equal(lookup(start, end), expected);
  }
}

const large = Array.from({ length: 9000 }, (_, index) => ({ text: `word-${index}`, start: index * 350, end: index * 350 + 200 }));
const deleted = new Set(large.flatMap((_, index) => index % 2 ? [index] : []));
for (const excluded of [new Set<number>(), deleted]) {
  assert.deepEqual(projectRetimedWords(large, excluded, 30, 0), reference(large, excluded, 30, 0));
}
function medianMs(run: () => unknown) {
  for (let i = 0; i < 3; i++) run();
  const timings = Array.from({ length: 9 }, () => { const start = performance.now(); run(); return performance.now() - start; });
  return timings.sort((a, b) => a - b)[4];
}
const before = medianMs(() => { reference(large, deleted, 30, 0); reference(large, deleted, 30, 0); });
const after = medianMs(() => projectRetimedWords(large, deleted, 30, 0));
console.log(`projection.verify: 800 randomized parity cases passed; 9000 words/4500 segments old two passes ${before.toFixed(2)}ms, shared projection ${after.toFixed(2)}ms (synthetic median)`);
