// Pure-logic checks for the Silero VAD runner: 16 kHz resampling and
// probability → speech-span aggregation. The model session itself is exercised
// in the live browser smoke (wasm + onnx), not here.
import assert from 'node:assert/strict';
import { resampleMonoTo16k, vadSpansFromProbabilities } from './silero-vad';

// ── resampling ───────────────────────────────────────────────────────────────

const ramp = new Float32Array(160); // 10ms @16kHz
for (let i = 0; i < ramp.length; i += 1) ramp[i] = i / ramp.length;
assert.equal(resampleMonoTo16k(ramp, 16_000), ramp, '16k passes through unchanged');
const down = resampleMonoTo16k(ramp, 32_000);
assert.equal(down.length, 80, '32k decimates to half length');
assert.ok(Math.abs(down[0] - 0) < 1e-6, 'first sample preserved');
assert.throws(() => resampleMonoTo16k(ramp, 8_000), /unsupported sample rate/);

// ── span aggregation ─────────────────────────────────────────────────────────

const WINDOW_MS = 32;
const prob = (length: number, on: Array<[number, number]>, level = 0.9): Float32Array => {
  const out = new Float32Array(length).fill(0.05);
  for (const [start, end] of on) out.fill(level, start, end);
  return out;
};

const simple = vadSpansFromProbabilities(prob(100, [[10, 30]]), 0.5, { windowMs: WINDOW_MS });
assert.equal(simple.spans.length, 1);
assert.deepEqual(simple.spans[0], { startMs: 320, endMs: 960, confidence: 0.9 });
assert.ok(Math.abs(simple.confidence - 0.9) < 1e-6);

// A gap of at most mergeGapWindows stays one span.
const gapped = vadSpansFromProbabilities(prob(100, [[10, 20], [22, 30]]), 0.5, { windowMs: WINDOW_MS });
assert.equal(gapped.spans.length, 1, 'gap of 2 windows merges');
assert.equal(gapped.spans[0].startMs, 320);
assert.equal(gapped.spans[0].endMs, 960);

// A longer gap splits into two spans.
const split = vadSpansFromProbabilities(prob(100, [[10, 20], [30, 40]]), 0.5, { windowMs: WINDOW_MS });
assert.equal(split.spans.length, 2);
assert.equal(split.spans[0].endMs, 640);
assert.equal(split.spans[1].startMs, 960);
// Everything below threshold → no spans, zero confidence.
const quiet = vadSpansFromProbabilities(prob(50, []), 0.5, { windowMs: WINDOW_MS });
assert.equal(quiet.spans.length, 0);
assert.equal(quiet.confidence, 0);

// Confidence is the mean of the speaking windows.
const mixed = vadSpansFromProbabilities(prob(100, [[10, 20]], 0.8), 0.5, { windowMs: WINDOW_MS });
assert.ok(Math.abs(mixed.confidence - 0.8) < 1e-6);

console.log('silero-vad.check: resampling + span aggregation OK');
