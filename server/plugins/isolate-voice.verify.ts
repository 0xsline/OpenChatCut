import assert from 'node:assert/strict';
import {
  VOICE_ISOLATION_ENGINE_VERSION,
  voiceIsolationArtifactName,
} from './isolate-voice.ts';
import { voiceIsolationMix } from '../../src/audio/voiceMix.ts';

const source = 'interview.master.mp4';
const revision = 'source-v1-a1b2c3d4';
const light = voiceIsolationArtifactName(source, revision, 35);
const strong = voiceIsolationArtifactName(source, revision, 90);
const forcedA = voiceIsolationArtifactName(source, revision, 90, 'force-a');
const forcedB = voiceIsolationArtifactName(source, revision, 90, 'force-b');

assert.notEqual(light, strong, 'strength participates in the immutable artifact identity');
assert.notEqual(forcedA, forcedB, 'force requests always receive a fresh artifact path');
assert.notEqual(strong, forcedA, 'force never overwrites the shared deterministic artifact');
assert.ok(strong.includes(revision));
assert.ok(strong.includes(VOICE_ISOLATION_ENGINE_VERSION));
assert.ok(strong.includes('.s90.'));
assert.notEqual(strong, source, 'a derived artifact can never alias the shared master path');

assert.deepEqual(voiceIsolationMix(0), { dry: 1, wet: 0 });
const fullWet = voiceIsolationMix(100);
assert.ok(Math.abs(fullWet.dry) < 1e-12 && fullWet.wet === 1);
const midpoint = voiceIsolationMix(50);
assert.ok(midpoint.dry > 0 && midpoint.wet > 0, 'intermediate strength renders both master and isolated audio');
assert.ok(Math.abs(midpoint.dry ** 2 + midpoint.wet ** 2 - 1) < 1e-12, 'dry/wet mix is equal-power');

console.log('isolate-voice.verify: ok');
