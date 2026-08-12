import assert from 'node:assert/strict';
import { whisperTokensToChunks } from './native-asr-utils';

// Language mapping and token->chunk projection are pure; the real whisper-cli
// invocation is exercised by the desktop smoke (native-asr-service).
const transcription = [
  {
    text: 'Hello world.',
    tokens: [
      { text: 'Hello', offsets: { from: 80, to: 350 } },
      { text: ' world', offsets: { from: 350, to: 550 } },
      { text: '.', offsets: { from: 550, to: 620 } },
    ],
  },
  {
    text: 'This is fine.',
    tokens: [
      { text: ' This', offsets: { from: 900, to: 1200 } },
      { text: ' is', offsets: { from: 1200, to: 1340 } },
      { text: ' fine', offsets: { from: 1340, to: 1700 } },
      { text: '.', offsets: { from: 1700, to: 1780 } },
    ],
  },
];
const projected = whisperTokensToChunks(transcription as never);
assert.equal(projected.text, 'Hello world.\nThis is fine.', 'segment text is joined');
assert.deepEqual(
  projected.chunks.map((chunk) => chunk.text),
  ['Hello', 'world', 'This', 'is', 'fine'],
  'punctuation-only tokens are dropped, word tokens are kept in order',
);
assert.deepEqual(
  projected.chunks.map((chunk) => [chunk.start, chunk.end]),
  [[80, 350], [350, 550], [900, 1200], [1200, 1340], [1340, 1700]],
  'millisecond offsets are preserved',
);

// Special tokens (BOS/EOS/silence) and empty entries are skipped.
const noisy = whisperTokensToChunks([
  { text: '', tokens: [{ text: '[BOS]', offsets: { from: 0, to: 1 } }] },
  { text: '', tokens: [{ text: '', offsets: { from: 1, to: 2 } }] },
] as never);
assert.equal(noisy.text, '', 'empty and special tokens produce no text');
assert.equal(noisy.chunks.length, 0, 'no chunks from special tokens');

console.log('native-asr-worker.verify: whisper token projection OK');
