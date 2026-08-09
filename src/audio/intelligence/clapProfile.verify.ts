import assert from 'node:assert/strict';
import {
  classifyClapEmbedding,
  parseClapPrototypeProfile,
  type ClapPrototypeProfile,
} from './clapProfile';
import { CLAP_EMBEDDING_DIMENSION } from './clapTypes';
import type { MusicTagKind } from './types';

function axis(index: number): number[] {
  return Array.from({ length: CLAP_EMBEDDING_DIMENSION }, (_, dimension) => dimension === index ? 1 : 0);
}

const labels: Array<{ kind: MusicTagKind; label: string; vector: number[] }> = [
  { kind: 'genre', label: 'zeta', vector: axis(0) },
  { kind: 'genre', label: 'alpha', vector: axis(0) },
  { kind: 'mood', label: 'calm', vector: axis(0) },
  { kind: 'instrument', label: 'piano', vector: axis(0) },
  { kind: 'usage', label: 'vlog', vector: axis(0) },
];
const profile: ClapPrototypeProfile = parseClapPrototypeProfile({ labels });
const embedding = axis(0);

const tags = classifyClapEmbedding(embedding, profile, {
  thresholds: { genre: 0.5, mood: 0.5, instrument: 0.5, usage: 0.5 },
});
assert.equal(tags.length, 4, 'classification returns one top tag per category');
assert.deepEqual(tags[0], { kind: 'genre', label: 'alpha', score: 1 },
  'equal scores use a stable label tie-break');
assert.deepEqual(tags.map((tag) => tag.kind), ['genre', 'mood', 'instrument', 'usage']);

const unknown = classifyClapEmbedding(embedding, profile, {
  thresholds: { genre: 1, mood: 1, instrument: 1, usage: 1 },
});
assert.equal(unknown.every((tag) => tag.label !== 'unknown'), true,
  'a score equal to the threshold remains classified');
const conservativeUnknown = classifyClapEmbedding(embedding, profile, {
  thresholds: { genre: 0.5, mood: 0.5, instrument: 0.5, usage: 0.5 },
});
const orthogonal = classifyClapEmbedding(axis(1), profile, {
  thresholds: { genre: 0.01, mood: 0.01, instrument: 0.01, usage: 0.01 },
});
assert.equal(conservativeUnknown[0]!.score, 1, 'scores are stable rounded cosine values');
assert.equal(orthogonal.every((tag) => tag.label === 'unknown'), true,
  'adjustable thresholds produce explicit unknown tags below threshold');
assert.equal(orthogonal.every((tag) => tag.score === 0), true);

assert.throws(() => parseClapPrototypeProfile({
  labels: labels.map((label, index) => index === 0 ? { ...label, vector: axis(0).slice(1) } : label),
}), /511 dimensions; expected 512/, 'malformed prototype dimensions are rejected');

assert.throws(() => parseClapPrototypeProfile({
  labels: labels.map((label, index) => index === 0 ? { ...label, vector: new Array(512).fill(0) } : label),
}), /zero length/, 'zero prototype vectors are rejected');

console.log('clapProfile.verify: ok');
