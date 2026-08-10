import assert from 'node:assert/strict';
import {
  DEFAULT_SAMPLING_CONFIG,
  normalizeSamplingConfig,
  readSamplingConfig,
  writeSamplingConfig,
} from './samplingConfig';

assert.deepEqual(
  normalizeSamplingConfig(null),
  DEFAULT_SAMPLING_CONFIG,
  'null falls back to defaults',
);
assert.deepEqual(
  normalizeSamplingConfig({}),
  DEFAULT_SAMPLING_CONFIG,
  'empty object falls back to defaults',
);
assert.deepEqual(
  normalizeSamplingConfig({ intervalSeconds: 30 }),
  { intervalSeconds: 30, maxFallbackFrames: 12, maxSceneFrames: 96, resultLimit: 24, relativeFloor: 0.85, duplicateThreshold: 0.985, longVideoSeconds: 60 },
  'partial patch keeps defaults for the remaining fields',
);
assert.deepEqual(
  normalizeSamplingConfig({ intervalSeconds: 0, maxFallbackFrames: 999, maxSceneFrames: -3 }),
  { intervalSeconds: 1, maxFallbackFrames: 480, maxSceneFrames: 1, resultLimit: 24, relativeFloor: 0.85, duplicateThreshold: 0.985, longVideoSeconds: 60 },
  'out-of-range values are clamped to the documented bounds',
);
assert.deepEqual(
  normalizeSamplingConfig({ intervalSeconds: 'abc', maxFallbackFrames: 5, maxSceneFrames: 5 }),
  { intervalSeconds: 15, maxFallbackFrames: 5, maxSceneFrames: 5, resultLimit: 24, relativeFloor: 0.85, duplicateThreshold: 0.985, longVideoSeconds: 60 },
  'non-numeric fields fall back independently',
);
assert.deepEqual(
  normalizeSamplingConfig({
    resultLimit: 0, relativeFloor: 2, duplicateThreshold: -1, longVideoSeconds: 5,
  }),
  { intervalSeconds: 15, maxFallbackFrames: 12, maxSceneFrames: 96, resultLimit: 1, relativeFloor: 1, duplicateThreshold: 0, longVideoSeconds: 10 },
  'search parameters are clamped to their documented bounds',
);
assert.deepEqual(
  normalizeSamplingConfig({
    resultLimit: 'abc', relativeFloor: 'abc', duplicateThreshold: 'abc', longVideoSeconds: 'abc',
  }),
  DEFAULT_SAMPLING_CONFIG,
  'non-numeric search parameters fall back independently',
);

// tsx runs under Node: no localStorage, so reads must degrade to defaults
// and writes must be safe no-ops.
assert.deepEqual(
  readSamplingConfig(),
  DEFAULT_SAMPLING_CONFIG,
  'read outside a browser returns defaults',
);
assert.equal(
  writeSamplingConfig(DEFAULT_SAMPLING_CONFIG),
  undefined,
  'write outside a browser is a no-op',
);

// mediaFrames consumes the config: explicit caps are honored, and the
// default resolves through readSamplingConfig (no stored config → 96).
const mediaFrames = await import('./mediaFrames');
const boundaries = [10, 20, 30];
assert.equal(
  mediaFrames.sceneAwareSamplePlan(120, boundaries).length,
  4,
  'default scene cap applies when no sampling config is stored',
);
assert.equal(
  mediaFrames.sceneAwareSamplePlan(120, boundaries, 2).length,
  2,
  'an explicit scene cap overrides the stored/default config',
);

console.log('samplingConfig.verify: all assertions passed');
