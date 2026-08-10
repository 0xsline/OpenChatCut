// Pure align checks. Run: npx tsx src/multicam/align.check.ts
import assert from 'node:assert/strict';
import { downsample, findLag, mixToMono, removeDc } from './align';

// broadband noise (sines alone have multi-period peaks)
function noise(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}

{
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([4, 5, 6]);
  const m = mixToMono([a, b], 3);
  assert.deepEqual([...m], [2.5, 3.5, 4.5]);
}

{
  const src = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
  const d = downsample(src, 8, 4);
  assert.ok(d.length === 4);
}

{
  const z = removeDc(new Float32Array([2, 2, 2]));
  assert.ok(Math.abs(z[0]!) < 1e-6);
}

// delayed copy: other is ref shifted by +400 samples @ 4k (= 0.1s)
{
  const rate = 4000;
  const ref = noise(rate * 2, 7);
  const lag = 400;
  const other = new Float32Array(ref.length);
  for (let i = lag; i < ref.length; i++) other[i] = ref[i - lag]!;
  const r = findLag(ref, other, rate);
  assert.ok(Math.abs(r.lagSamples - lag) <= 8, `lag ${r.lagSamples} expected ~${lag}`);
  assert.ok(r.confidence > 0.02, `confidence ${r.confidence}`);
}

// negative lag: other advanced (content starts earlier in the buffer)
{
  const rate = 4000;
  const ref = noise(rate * 2, 11);
  const lag = 200;
  const other = new Float32Array(ref.length);
  for (let i = 0; i < ref.length - lag; i++) other[i] = ref[i + lag]!;
  const r = findLag(ref, other, rate);
  assert.ok(Math.abs(r.lagSamples + lag) <= 8, `lag ${r.lagSamples} expected ~${-lag}`);
}

console.log('align.check.ts: ok');
