// Runnable check: `npx tsx src/audio/silence.verify.ts`.
// Verification: Dead air detection on synthetic PCM (relative threshold/breathing port/minimum duration/music bed does not cut/pure noise floor does not exit the segment).
import assert from 'node:assert/strict';
import { detectSilentSpans, rmsEnvelope } from './silence';

const SR = 48_000;

/** Synthesize mono: Press [amplitude, milliseconds] to segment the waveform (sine 220Hz, amplitude control level). */
function synth(segments: Array<[amp: number, ms: number]>): Float32Array {
  const total = segments.reduce((a, [, ms]) => a + Math.round((SR * ms) / 1000), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const [amp, ms] of segments) {
    const n = Math.round((SR * ms) / 1000);
    for (let i = 0; i < n; i++) out[at + i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
    at += n;
  }
  return out;
}

const WIN = 50;
const spansOf = (samples: Float32Array, params = {}) =>
  detectSilentSpans(rmsEnvelope(samples, SR, WIN), WIN, params);

// ── Voice - long pause - voice: find the dead breath segment in the middle, and the boundary includes the breathing port ──
const talkPauseTalk = synth([[0.3, 2000], [0.002, 1500], [0.3, 2000]]);
const spans = spansOf(talkPauseTalk);
assert.equal(spans.length, 1, '一段长停顿 → 一个死气段');
const [span] = spans;
assert.ok(span!.startMs >= 2000 && span!.startMs <= 2000 + 300, `起点在停顿开始+呼吸口附近(${span!.startMs})`);
assert.ok(span!.endMs <= 3500 - 100 && span!.endMs >= 3500 - 400, `终点留呼吸口(${span!.endMs})`);

// ── Short pause (< minSilenceMs) without moving ──
assert.equal(spansOf(synth([[0.3, 1000], [0.002, 400], [0.3, 1000]])).length, 0, '400ms 停顿不删');

// ──Customized minSilenceMs takes effect──
assert.equal(spansOf(synth([[0.3, 1000], [0.002, 400], [0.3, 1000]]), { minSilenceMs: 300 }).length, 1, '调低下限后 400ms 可删');

// ── Music bed: continuous sound, zero life ──
assert.equal(spansOf(synth([[0.2, 5000]])).length, 0, '持续音乐不切');

// ── Pure noise (no voice reference): no segment ──
assert.equal(spansOf(synth([[0.003, 5000]])).length, 0, '整段没语音 → 不动');

// ── Relative threshold: soft voice segments (lower than speech but not low enough) are not considered dead ──
const softMid = synth([[0.3, 1500], [0.05, 1500], [0.3, 1500]]);
assert.equal(spansOf(softMid).length, 0, '-16dB 的轻声不删');
const deadMid = synth([[0.3, 1500], [0.005, 1500], [0.3, 1500]]);
assert.equal(spansOf(deadMid).length, 1, '-36dB 的死气删');

// ──Multiple pauses to hit one by one──
const multi = synth([[0.3, 1200], [0.002, 900], [0.3, 1200], [0.002, 800], [0.3, 1200]]);
assert.equal(spansOf(multi).length, 2, '两段停顿 → 两个死气段');

// ── Empty input / illegal window ──
assert.deepEqual(spansOf(new Float32Array(0)), [], '空输入');
assert.deepEqual(detectSilentSpans(new Float32Array(0), 0), [], '零窗口');

console.log('silence.verify: ok (相对阈值/呼吸口/最短时长/音乐床/底噪守门)');
