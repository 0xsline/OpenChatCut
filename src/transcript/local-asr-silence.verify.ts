import assert from 'node:assert/strict';
import { hasTranscribableSignal } from './client-asr-extract';

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

console.log('local-asr-silence.verify: near-silent media returns an empty transcript before inference');
