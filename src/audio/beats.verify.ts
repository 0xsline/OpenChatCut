// Runnable check: `npx tsx src/audio/beats.verify.ts`.
// 验证:合成打点音轨的 BPM/拍点/强拍/可信度守门(120·90 BPM、重音小节、噪声、静音)。
import assert from 'node:assert/strict';
import { analyzeBeats } from './beats';

const SR = 44_100;

/** mulberry32:32 位安全 PRNG(经典 LCG 在 JS 双精度下会退化成短周期)。 */
function makeRand(seedInit: number): () => number {
  let seed = seedInit | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** 合成打点音轨:bpm 间隔的短爆发(8ms 白噪),accentEvery>0 时每 N 拍加重。 */
function clickTrack(bpm: number, seconds: number, accentEvery = 0, noiseAmp = 0.005): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  const rand = makeRand(42);
  for (let i = 0; i < out.length; i++) out[i] = noiseAmp * rand();
  const period = (60 / bpm) * SR;
  const burst = Math.round(0.008 * SR);
  for (let beat = 0; beat * period < out.length; beat++) {
    const amp = accentEvery > 0 && beat % accentEvery === 0 ? 0.95 : 0.45;
    const start = Math.round(beat * period);
    for (let i = 0; i < burst && start + i < out.length; i++) out[start + i] += amp * rand() * 2;
  }
  return out;
}

// ── 120 BPM:BPM 命中 ±1.5,拍点与真拍差 ≤ 45ms,可信度高 ──
{
  const r = analyzeBeats(clickTrack(120, 15), SR);
  assert.ok(Math.abs(r.bpm - 120) < 1.5, `bpm≈120(${r.bpm})`);
  assert.ok(r.confidence >= 2, `可信度足够(${r.confidence})`);
  assert.ok(r.beats.length >= 24, `拍数合理(${r.beats.length})`);
  const period = 60 / 120;
  const misses = r.beats.slice(2, 22).filter((t) => {
    const nearest = Math.round(t / period) * period;
    return Math.abs(t - nearest) > 0.045;
  });
  assert.equal(misses.length, 0, `拍点对齐真拍(offenders=${misses.length})`);
}

// ── 90 BPM:倍频偏好不会错锁 180/45 ──
{
  const r = analyzeBeats(clickTrack(90, 15), SR);
  assert.ok(Math.abs(r.bpm - 90) < 1.5, `bpm≈90(${r.bpm})`);
}

// ── 4 拍重音:强拍锁在重音相位(与重音拍差 ≤ 60ms),且每 4 拍一个 ──
{
  const r = analyzeBeats(clickTrack(120, 16, 4), SR);
  assert.ok(r.downbeats.length >= 5, `强拍数量(${r.downbeats.length})`);
  const bar = (60 / 120) * 4;
  const offenders = r.downbeats.slice(1, 6).filter((t) => {
    const nearest = Math.round(t / bar) * bar;
    return Math.abs(t - nearest) > 0.06;
  });
  assert.equal(offenders.length, 0, '强拍落在重音小节起点');
}

// ── 纯噪声:可信度守门,不产出节拍 ──
{
  const noise = new Float32Array(SR * 10);
  const rand = makeRand(7);
  for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * rand();
  const r = analyzeBeats(noise, SR);
  assert.equal(r.beats.length, 0, `噪声不出拍(bpm=${r.bpm}, conf=${r.confidence})`);
}

// ── 过短/空输入 ──
assert.equal(analyzeBeats(new Float32Array(SR), SR).bpm, 0, '1s 素材太短');
assert.equal(analyzeBeats(new Float32Array(0), SR).bpm, 0, '空输入');

console.log('beats.verify: ok (120/90 BPM/重音强拍/噪声守门/短输入)');
