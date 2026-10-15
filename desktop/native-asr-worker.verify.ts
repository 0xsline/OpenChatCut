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
    // whisper.cpp publishes medium as q5_0; there is no q5_1 medium build.
    'ggml-medium-q5_0.bin',
    'ggml-large-v3-turbo-q5_0.bin',
  ],
  'desktop-native GGML resolution covers every supported tier',
);
assert.equal(nativeGgmlFileName('unknown/model'), undefined, 'unknown models stay unsupported');

// Language mapping and token->chunk projection are pure; the real whisper-cli
// invocation is exercised by the desktop smoke (native-asr-service).
// whisper.cpp emits BPE tokens: a token that starts with a space opens a word,
// following fragments extend it, punctuation trails the word it belongs to.
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
  ['Hello', 'world.', 'This', 'is', 'fine.'],
  'one chunk per word, with trailing punctuation attached',
);
assert.deepEqual(
  projected.chunks.map((chunk) => [chunk.start, chunk.end]),
  [[80, 350], [350, 620], [900, 1200], [1200, 1340], [1340, 1780]],
  'a joined word spans its first to its last token, milliseconds preserved',
);

// Russian and Korean words need several BPE tokens; both fixtures are captured
// verbatim from whisper.cpp v1.9.2 (`-ojf` with ggml-base-q5_1.bin).
const russian = [
  {
    text: ' Привет! Это тестовая',
    tokens: [
      { text: ' Привет', offsets: { from: 240, to: 640 } },
      { text: '!', offsets: { from: 1740, to: 1970 } },
      { text: ' Это', offsets: { from: 2050, to: 2720 } },
      { text: ' тест', offsets: { from: 2720, to: 3620 } },
      { text: 'ов', offsets: { from: 3620, to: 4070 } },
      { text: 'ая', offsets: { from: 4070, to: 4470 } },
    ],
  },
  {
    text: ' запись для проверки',
    tokens: [
      { text: ' зап', offsets: { from: 4530, to: 4880 } },
      { text: 'ись', offsets: { from: 5220, to: 5240 } },
      { text: ' для', offsets: { from: 6090, to: 6540 } },
      { text: ' провер', offsets: { from: 6610, to: 7920 } },
      { text: 'ки', offsets: { from: 7920, to: 8370 } },
    ],
  },
];
const russianChunks = whisperTokensToChunks(russian as never).chunks;
assert.deepEqual(
  russianChunks.map((chunk) => chunk.text),
  ['Привет!', 'Это', 'тестовая', 'запись', 'для', 'проверки'],
  'sub-word tokens join into words and keep sentence punctuation',
);
assert.deepEqual(
  russianChunks.map((chunk) => [chunk.start, chunk.end]),
  [[240, 1970], [2050, 2720], [2720, 4470], [4530, 5240], [6090, 6540], [6610, 8370]],
  'joined words keep the first/last token offsets',
);

// Korean is written with spaces, yet whisper.cpp still splits eojeol
// (회의는 = 회 + 의), so Hangul must not be treated as a space-less script.
const korean = [
  {
    text: ' "안녕하세요?"',
    tokens: [
      { text: ' "', offsets: { from: 150, to: 150 } },
      { text: '안녕', offsets: { from: 220, to: 770 } },
      { text: '하세요', offsets: { from: 770, to: 990 } },
      { text: '?"', offsets: { from: 1880, to: 1880 } },
    ],
  },
  {
    text: ' 오늘 회의는 3시에 시작합니다.',
    tokens: [
      { text: ' 오늘', offsets: { from: 2100, to: 2230 } },
      { text: ' 회', offsets: { from: 2230, to: 2400 } },
      { text: '의', offsets: { from: 2400, to: 2520 } },
      { text: '는', offsets: { from: 2600, to: 2740 } },
      { text: ' 3', offsets: { from: 2740, to: 2870 } },
      { text: '시에', offsets: { from: 3260, to: 3610 } },
      { text: ' 시작', offsets: { from: 3870, to: 3960 } },
      { text: '합니다', offsets: { from: 3960, to: 4480 } },
      { text: '.', offsets: { from: 4480, to: 5040 } },
    ],
  },
];
const koreanChunks = whisperTokensToChunks(korean as never).chunks;
assert.deepEqual(
  koreanChunks.map((chunk) => chunk.text),
  ['"안녕하세요?"', '오늘', '회의는', '3시에', '시작합니다.'],
  'Korean words rejoin across BPE splits instead of fragmenting',
);
assert.deepEqual(
  koreanChunks.map((chunk) => [chunk.start, chunk.end]),
  [[150, 1880], [2100, 2230], [2230, 2740], [2740, 3610], [3870, 5040]],
  'Korean words span their first and last token offsets',
);

// Special tokens (BOS/EOS/silence) and empty entries are skipped.
const noisy = whisperTokensToChunks([
  { text: '', tokens: [{ text: '[BOS]', offsets: { from: 0, to: 1 } }] },
  { text: '', tokens: [{ text: '', offsets: { from: 1, to: 2 } }] },
] as never);
assert.equal(noisy.text, '', 'empty and special tokens produce no text');
assert.equal(noisy.chunks.length, 0, 'no chunks from special tokens');

console.log('native-asr-worker.verify: whisper token projection OK');

// whisper-server verbose_json words projection (seconds -> ms): the same BPE
// tokens, punctuation attached, space-less scripts stay split per token.
const serverWords = whisperWordsToChunks([
  { word: '大家好', start: 0.01, end: 0.73 },
  { word: ',', start: 1.13, end: 1.22 },
  { word: '歡迎', start: 1.22, end: 1.64 },
] as never);
assert.deepEqual(
  serverWords,
  [
    { text: '大家好,', start: 10, end: 1220 },
    { text: '歡迎', start: 1220, end: 1640 },
  ],
  'server words project to ms chunks; punctuation attaches, space-less scripts stay split',
);
assert.equal(whisperWordsToChunks(undefined).length, 0, 'missing words yield no chunks');

console.log('native-asr-worker.verify: whisper server words projection OK');
