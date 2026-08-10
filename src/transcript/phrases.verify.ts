import assert from 'node:assert/strict';
import { joinTranscriptWords, packTranscriptPhrases } from './phrases';
import type { TranscriptWord } from './types';

assert.equal(
  joinTranscriptWords([{ text: '你好' }, { text: '，' }, { text: '世界' }, { text: '！' }]),
  '你好，世界！',
);
assert.equal(
  joinTranscriptWords([{ text: 'Hello' }, { text: ',' }, { text: 'world' }, { text: '!' }]),
  'Hello, world!',
);

const words: TranscriptWord[] = [
  { text: 'Hello', start: 100, end: 300, speaker: 'A' },
  { text: 'world', start: 350, end: 600, speaker: 'A' },
  { text: 'New', start: 650, end: 800, speaker: 'B' },
  { text: 'take', start: 1500, end: 1800, speaker: 'B' },
];
const phrases = packTranscriptPhrases(words, { sourceItemId: 'clip-a', silenceThresholdMs: 500 });
assert.equal(phrases.length, 3);
assert.deepEqual(phrases[0], {
  sourceItemId: 'clip-a',
  start: 100,
  end: 600,
  speaker: 'A',
  text: 'Hello world',
  silenceBefore: 100,
  wordCount: 2,
  wordRanges: [[0, 2]],
});
assert.equal(phrases[1]!.speaker, 'B', 'speaker change starts a phrase');
assert.equal(phrases[1]!.silenceBefore, 50);
assert.equal(phrases[2]!.silenceBefore, 700, 'long silence starts a phrase');

const sparse = packTranscriptPhrases(words, {
  sourceItemId: 'clip-a',
  silenceThresholdMs: 10_000,
  wordIndices: [0, 2, 3],
});
assert.deepEqual(sparse.flatMap((phrase) => phrase.wordRanges), [[0, 1], [2, 4]], 'ranges trace back to original word indices');

const longWords: TranscriptWord[] = Array.from({ length: 120 }, (_, index) => ({
  text: `word${index}`,
  start: index * 220,
  end: index * 220 + 180,
  speaker: 'A',
}));
const compact = packTranscriptPhrases(longWords, { sourceItemId: 'long', maxWordsPerPhrase: 40 });
assert.equal(compact.length, 3, 'long monologues are bounded into readable phrases');
assert.ok(JSON.stringify(compact).length < JSON.stringify(longWords).length, 'phrase view is smaller than raw word JSON');

console.log('transcript phrases checks passed');
