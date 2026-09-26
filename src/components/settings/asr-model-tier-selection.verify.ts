// Every catalog tier must survive the whole selection path: the settings sync
// that persists the choice, and the runtime resolution that reads it back.
//
// `large-v3-turbo` shipped with the catalog and chooseAsrConfig updated but the
// settings sync allow-list left behind. Selecting it wrote nothing, so the
// previously selected tier stayed in force and the user kept getting that
// model's failure no matter what they picked. The bug was invisible because
// both ends "worked" — only the hand-written list in between disagreed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASR_MODELS, ASR_MODEL_TIERS, isAsrModelTier } from '../../../shared/asr-models';
import { chooseAsrConfig } from '../../transcript/deviceProfile';
import type { DeviceProfile } from '../../transcript/local-asr-types';

const profile: DeviceProfile = {
  platform: 'mac',
  webgpu: { available: false },
  deviceMemoryGB: 32,
  hardwareConcurrency: 10,
};

// The tier list is the catalog plus '' (auto); it cannot be maintained by hand.
assert.deepEqual(
  [...ASR_MODEL_TIERS],
  ['', ...ASR_MODELS.map((entry) => entry.id)],
  'ASR_MODEL_TIERS must be derived from the catalog',
);

assert.equal(isAsrModelTier(''), true, 'empty string selects the auto tier');
assert.equal(isAsrModelTier('nope'), false, 'unknown tiers are rejected');
assert.equal(isAsrModelTier(undefined), false, 'non-strings are rejected');

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  },
});

// Mirrors SettingsDialog.syncLocalAsrModel: the saved setting is only persisted
// when the catalog recognises it. The source guard below keeps the mirror honest.
const syncLocalAsrModel = (saved: string | undefined): void => {
  if (isAsrModelTier(saved ?? '')) storage.set('cc.asrModel', saved ?? '');
};

// Both ends of the selection path must validate through the shared catalog
// predicate rather than an inline list of tier literals.
for (const file of ['SettingsDialog.tsx', '../../transcript/deviceProfile.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /isAsrModelTier/, `${file} must validate tiers against the catalog`);
  for (const entry of ASR_MODELS) {
    assert.doesNotMatch(
      source,
      new RegExp(`===\\s*'${entry.id}'`),
      `${file} must not compare against the '${entry.id}' literal; use isAsrModelTier`,
    );
  }
}

for (const entry of ASR_MODELS) {
  storage.set('cc.asrModel', 'medium');
  syncLocalAsrModel(entry.id);
  assert.equal(
    storage.get('cc.asrModel'),
    entry.id,
    `selecting ${entry.id} must overwrite the previous tier, not be discarded`,
  );
  const config = chooseAsrConfig(profile);
  assert.equal(config.modelTier, entry.id, `${entry.id} must resolve to itself at runtime`);
  assert.equal(config.modelId, entry.modelId, `${entry.id} must resolve to its catalog model`);
  assert.equal(config.revision, entry.revision, `${entry.id} must resolve to its pinned revision`);
}

// Auto ('') and unknown values both fall back to the default tier.
storage.set('cc.asrModel', 'medium');
syncLocalAsrModel('');
assert.equal(storage.get('cc.asrModel'), '', 'auto must be persistable');
assert.equal(chooseAsrConfig(profile).modelTier, 'base', 'auto resolves to the base tier');

storage.set('cc.asrModel', 'not-a-tier');
assert.equal(chooseAsrConfig(profile).modelTier, 'base', 'an unknown stored tier falls back to base');

console.log('asr-model-tier-selection.verify: every catalog tier survives settings sync and runtime resolution');
