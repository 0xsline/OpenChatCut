import assert from 'node:assert/strict';
import { deriveMusicSections } from './sections';

const beatsMs = Array.from({ length: 30 }, (_, index) => index * 1_000);
const beatEnergy = beatsMs.map((time) => time < 10_000 ? 0.1 : time < 20_000 ? 1 : 0.25);
const first = deriveMusicSections({ durationMs: 30_000, beatsMs, beatEnergy });
const second = deriveMusicSections({ durationMs: 30_000, beatsMs, beatEnergy });

assert.deepEqual(first, second, 'section derivation is deterministic');
assert.ok(first.length >= 2 && first.length <= 12, 'energy changes produce a bounded section list');
assert.equal(first[0]?.fromMs, 0);
assert.equal(first.at(-1)?.toMs, 30_000);
for (let index = 0; index < first.length; index += 1) {
  const section = first[index]!;
  assert.ok(section.toMs > section.fromMs);
  assert.ok(section.energy >= 0 && section.energy <= 1);
  assert.ok(section.boundaryConfidence >= 0 && section.boundaryConfidence <= 1);
  if (index > 0) assert.equal(section.fromMs, first[index - 1]?.toMs, 'sections remain contiguous');
}
assert.ok(first.some((section) => section.role === 'peak'), 'high-energy region is labeled as a peak');
assert.deepEqual(
  deriveMusicSections({ durationMs: 3_000, beatsMs: [], beatEnergy: [] }),
  [{ fromMs: 0, toMs: 3_000, role: 'steady', energy: 0.5, boundaryConfidence: 0.35 }],
);
assert.deepEqual(deriveMusicSections({ durationMs: 0, beatsMs: [], beatEnergy: [] }), []);

console.log('sections.verify: ok');
