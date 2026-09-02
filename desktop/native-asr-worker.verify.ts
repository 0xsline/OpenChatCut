import assert from 'node:assert/strict';
import {
  nativeGgmlFileName,
  whisperTokensToChunks,
  whisperWordsToChunks,
} from './native-asr-utils';

assert.deepEqual(
  [
    'Xenova/whisper-tiny',
    'onnx-community/whisper-base_timestamped',
    'Xenova/whisper-small',
    'Xenova/whisper-medium',
    'onnx-community/whisper-large-v3-turbo_timestamped',
  ].map(nativeGgmlFileName),
  [
    'ggml-tiny-q5_1.bin',
    'ggml-base-q5_1.bin',
    'ggml-small-q5_1.bin',
    'ggml-medium-q5_1.bin',
    'ggml-large-v3-turbo-q5_0.bin',
  ],
  'desktop-native GGML resolution covers every supported tier',
);
assert.equal(nativeGgmlFileName('unknown/model'), undefined, 'unknown models stay unsupported');

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

// whisper-server verbose_json words projection (seconds -> ms).
const serverWords = whisperWordsToChunks([
  { word: ' 大家好', start: 0.01, end: 0.73 },
  { word: ',', start: 1.13, end: 1.22 },
  { word: '歡迎', start: 1.22, end: 1.64 },
] as never);
assert.deepEqual(
  serverWords,
  [
    { text: '大家好', start: 10, end: 730 },
    { text: '歡迎', start: 1220, end: 1640 },
  ],
  'server words project to ms chunks with punctuation dropped',
);
assert.equal(whisperWordsToChunks(undefined).length, 0, 'missing words yield no chunks');

console.log('native-asr-worker.verify: whisper server words projection OK');
