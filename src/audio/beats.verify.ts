// Runnable check: `npx tsx src/audio/beats.verify.ts`.
// Verification: BPM/beat/downbeat/believability gatekeeping of the synthesized beat track (120·90 BPM, accented bars, noise, silence).
import assert from 'node:assert/strict';
import { analyzeBeats } from './beats';

const SR = 44_100;

/** mulberry32: 32-bit safe PRNG (classic LCG will degenerate into short period under JS double precision). */
function makeRand(seedInit: number): () => number {
  let seed = seedInit | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Synthetic beat track: short bursts of bpm intervals (8ms white noise), emphasis every N beats when accentEvery>0. */
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

// ── 120 BPM: BPM hit ±1.5, difference between beat point and real beat ≤ 45ms, high reliability ──
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

// ── 90 BPM: Octave preference will not be locked wrongly 180/45 ──
{
  const r = analyzeBeats(clickTrack(90, 15), SR);
  assert.ok(Math.abs(r.bpm - 90) < 1.5, `bpm≈90(${r.bpm})`);
}

// ── 4-beat accent: The strong beat is locked in the accent phase (difference from the accent beat ≤ 60ms), and one every 4 beats ──
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

// ── Pure noise: credibility gatekeeping, no beats produced ──
{
  const noise = new Float32Array(SR * 10);
  const rand = makeRand(7);
  for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * rand();
  const r = analyzeBeats(noise, SR);
  assert.equal(r.beats.length, 0, `噪声不出拍(bpm=${r.bpm}, conf=${r.confidence})`);
}

// ── Too short/empty input ──
assert.equal(analyzeBeats(new Float32Array(SR), SR).bpm, 0, '1s 素材太短');
assert.equal(analyzeBeats(new Float32Array(0), SR).bpm, 0, '空输入');

console.log('beats.verify: ok (120/90 BPM/重音强拍/噪声守门/短输入)');
