import assert from 'node:assert/strict';
import { hasTranscribableSignal } from './client-asr-extract';
import { isDegenerateAsrText, stripDegenerateSegments } from './asr-output';

const sampleRate = 16_000;
assert.equal(hasTranscribableSignal(new Float32Array(sampleRate), sampleRate), false);

const nearSilent = new Float32Array(sampleRate * 2);
nearSilent.fill(0.001);
nearSilent[0] = 0.02;
assert.equal(hasTranscribableSignal(nearSilent, sampleRate), false, 'a click over near-silence is not speech evidence');

const voiced = new Float32Array(sampleRate);
for (let index = 0; index < voiced.length; index += 1) {
  voiced[index] = 0.01 * Math.sin((2 * Math.PI * 220 * index) / sampleRate);
}
assert.equal(hasTranscribableSignal(voiced, sampleRate), true, 'sustained quiet speech-like energy remains transcribable');

// A tone is loud enough to pass the energy gate, so only VAD and this filter
// stand between it and a persisted caption. Both fixtures below were measured
// on a 5 s 440 Hz sine, the project's non-speech clip.
assert.equal(
  isDegenerateAsrText('!'.repeat(445)),
  true,
  'the browser engine returned one 445-character "!!!!…" chunk for a sine tone',
);
assert.equal(isDegenerateAsrText('Be'.repeat(887)), true, 'a "Beeeeee…" run is one unit repeated');
assert.equal(isDegenerateAsrText('abc'.repeat(200)), true, 'any short unit repeated to the end is degenerate');
assert.equal(isDegenerateAsrText('!!!'), false, 'a short exclamation is plausible speech');
assert.equal(isDegenerateAsrText('hahahahahaha'), false, 'short laughter stays below the degenerate length');
assert.equal(isDegenerateAsrText(''), false);
// Short fabrications like "(Bell)" are indistinguishable from real captions by
// shape, which is why the VAD gate, not this filter, is what removes them.
assert.equal(isDegenerateAsrText('(Bell)'), false);
assert.equal(isDegenerateAsrText('字幕by索兰娅'), false);

// Real speech must never be touched: this is the measured whisper output for
// the project's speech fixture.
for (const word of ['Aurolog', 'test', 'clip.', 'The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog.', 'Local', 'transcription', 'runs', 'offline', 'on', 'this', 'Mac.']) {
  assert.equal(isDegenerateAsrText(word), false, `"${word}" is speech and must survive the filter`);
}

// A degenerate chunk is dropped, and its text leaves the joined transcript too.
const hallucinated = stripDegenerateSegments(
  [
    { text: '!'.repeat(445), start: -20, end: 0 },
  ],
  '!'.repeat(445),
);
assert.deepEqual(hallucinated.segments, [], 'a hallucinated cue is dropped');
assert.equal(hallucinated.text, '', 'and its text does not survive as the transcript body');
assert.equal(hallucinated.dropped, true);

const mixed = stripDegenerateSegments(
  [
    { text: 'Aurolog', start: 0, end: 400 },
    { text: '!'.repeat(445), start: 400, end: 800 },
    { text: 'test', start: 800, end: 1200 },
  ],
  `Aurolog ${'!'.repeat(445)}test`,
);
assert.deepEqual(mixed.segments.map((segment) => segment.text), ['Aurolog', 'test']);
assert.equal(mixed.text, 'Aurolog test', 'the surviving words keep their original spacing');

const clean = stripDegenerateSegments(
  [{ text: 'Aurolog', start: 0, end: 400 }],
  'Aurolog test clip.',
);
assert.equal(clean.dropped, false);
assert.equal(clean.text, 'Aurolog test clip.', 'a clean transcript passes through untouched');
assert.equal(stripDegenerateSegments([], '').dropped, false, 'an empty transcript is not a drop');

console.log('local-asr-silence.verify: near-silent media returns an empty transcript before inference');
console.log('local-asr-silence.verify: degenerate whisper output is dropped, speech is untouched');
