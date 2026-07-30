// Runnable check: `npx tsx src/audio/silence.verify.ts`.
// 验证:合成 PCM 上的死气检测(相对阈值/呼吸口/最短时长/音乐床不切/纯底噪不出段)。
import assert from 'node:assert/strict';
import { detectSilentSpans, rmsEnvelope } from './silence';

const SR = 48_000;

/** 合成单声道:按 [幅度, 毫秒] 段拼波形(正弦 220Hz,幅度控制电平)。 */
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

// ── 语音-长停-语音:找到中间死气段,边界含呼吸口 ──
const talkPauseTalk = synth([[0.3, 2000], [0.002, 1500], [0.3, 2000]]);
const spans = spansOf(talkPauseTalk);
assert.equal(spans.length, 1, '一段长停顿 → 一个死气段');
const [span] = spans;
assert.ok(span!.startMs >= 2000 && span!.startMs <= 2000 + 300, `起点在停顿开始+呼吸口附近(${span!.startMs})`);
assert.ok(span!.endMs <= 3500 - 100 && span!.endMs >= 3500 - 400, `终点留呼吸口(${span!.endMs})`);

// ── 短停顿(< minSilenceMs)不动 ──
assert.equal(spansOf(synth([[0.3, 1000], [0.002, 400], [0.3, 1000]])).length, 0, '400ms 停顿不删');

// ── 自定义 minSilenceMs 生效 ──
assert.equal(spansOf(synth([[0.3, 1000], [0.002, 400], [0.3, 1000]]), { minSilenceMs: 300 }).length, 1, '调低下限后 400ms 可删');

// ── 音乐床:持续有声,零死气 ──
assert.equal(spansOf(synth([[0.2, 5000]])).length, 0, '持续音乐不切');

// ── 纯底噪(无语音参照):不出段 ──
assert.equal(spansOf(synth([[0.003, 5000]])).length, 0, '整段没语音 → 不动');

// ── 相对阈值:轻声段(比语音低但没低够)不算死气 ──
const softMid = synth([[0.3, 1500], [0.05, 1500], [0.3, 1500]]);
assert.equal(spansOf(softMid).length, 0, '-16dB 的轻声不删');
const deadMid = synth([[0.3, 1500], [0.005, 1500], [0.3, 1500]]);
assert.equal(spansOf(deadMid).length, 1, '-36dB 的死气删');

// ── 多段停顿逐个命中 ──
const multi = synth([[0.3, 1200], [0.002, 900], [0.3, 1200], [0.002, 800], [0.3, 1200]]);
assert.equal(spansOf(multi).length, 2, '两段停顿 → 两个死气段');

// ── 空输入 / 非法窗口 ──
assert.deepEqual(spansOf(new Float32Array(0)), [], '空输入');
assert.deepEqual(detectSilentSpans(new Float32Array(0), 0), [], '零窗口');

console.log('silence.verify: ok (相对阈值/呼吸口/最短时长/音乐床/底噪守门)');
