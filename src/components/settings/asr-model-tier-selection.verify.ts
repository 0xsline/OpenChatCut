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
import { ASR_MODELS, ASR_MODEL_TIERS, asrModelEntry, isAsrModelTier } from '../../../shared/asr-models';
import { chooseAsrConfig } from '../../transcript/deviceProfile';
import { assertAnyLocalAsrInstalled, autoAsrTier } from '../../transcript/local-asr-tier';
import { TranscriptionError } from '../../transcript/assemblyai';
import type { DeviceProfile } from '../../transcript/local-asr-types';
import type { LocalAsrModelStatus } from '../../transcript/local-asr-readiness';

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

// Auto ('') is the tier the user leaves on "自动（按设备内存选择）". It must
// follow the installed catalog: resolving to a tier nobody downloaded is the
// `auto → base` bug, where a user with only `small` got a "Whisper Base ONNX
// files are incomplete" failure instead of the model on disk.
storage.set('cc.asrModel', 'medium');
syncLocalAsrModel('');
assert.equal(storage.get('cc.asrModel'), '', 'auto must be persistable');

/** Every catalog row, with `id` the only one downloaded. */
const onlyInstalled = (id: string | null): LocalAsrModelStatus[] => ASR_MODELS.map((entry) => {
  const ready = entry.id === id;
  return {
    modelId: entry.modelId, label: entry.label,
    downloaded: ready, onnxDownloaded: ready, ggmlDownloaded: ready,
  };
});

// The exact production case: 32 GB Mac (memory pick = small) with only small
// downloaded. `auto` used to answer base here.
assert.equal(
  chooseAsrConfig(profile, onlyInstalled('small')).modelTier,
  'small',
  'auto must pick the memory tier when it is the one that is installed',
);

// Memory pick missing → the best installed tier, never an un-downloaded one.
assert.equal(chooseAsrConfig(profile, onlyInstalled('base')).modelTier, 'base');
assert.equal(chooseAsrConfig(profile, onlyInstalled('medium')).modelTier, 'medium');
assert.equal(chooseAsrConfig(profile, onlyInstalled('tiny')).modelTier, 'tiny');
assert.equal(chooseAsrConfig(profile, onlyInstalled('large-v3-turbo')).modelTier, 'large-v3-turbo');
assert.equal(
  chooseAsrConfig(profile, onlyInstalled('medium')).modelId,
  asrModelEntry('medium')!.modelId,
  'the resolved tier carries its catalog model and revision',
);

const lowMemory: DeviceProfile = { ...profile, deviceMemoryGB: 4 };
assert.equal(autoAsrTier(4, null), 'base', 'under 6 GB the memory pick is base');
assert.equal(
  chooseAsrConfig(lowMemory, onlyInstalled('small')).modelTier,
  'small',
  'a low-memory machine whose only download is small uses small',
);
assert.equal(
  chooseAsrConfig(lowMemory, onlyInstalled(null)).modelTier,
  'base',
  'nothing installed keeps the memory tier so the error can name its files',
);
assert.equal(autoAsrTier(32, onlyInstalled(null)), null, 'auto has no answer when nothing is installed');

// Catalog unreadable: the documented memory rule still applies.
assert.equal(chooseAsrConfig(profile, null).modelTier, 'small', '32 GB → small');
assert.equal(chooseAsrConfig(lowMemory, null).modelTier, 'base', '4 GB → base');
assert.equal(chooseAsrConfig(profile).modelTier, 'small', 'no catalog argument → the memory rule');

// An explicit choice always wins over the catalog.
storage.set('cc.asrModel', 'tiny');
assert.equal(
  chooseAsrConfig(profile, onlyInstalled('small')).modelTier,
  'tiny',
  'an explicit tier is not overridden by what is installed',
);

// "Nothing installed" is a download prompt, not a per-engine verification error
// for a tier the user never had; an empty catalog is an older server, not proof.
storage.set('cc.asrModel', '');
assert.throws(
  () => assertAnyLocalAsrInstalled(onlyInstalled(null)),
  (error: unknown) => error instanceof TranscriptionError
    && /尚未安装任何模型/.test(error.detail ?? '')
    && /设置 → 本地模型 → 本地转写/.test(error.detail ?? ''),
  'nothing installed must point at the download page',
);
assert.doesNotThrow(() => assertAnyLocalAsrInstalled(onlyInstalled('small')));
assert.doesNotThrow(() => assertAnyLocalAsrInstalled(null), 'an unreadable catalog does not block');
assert.doesNotThrow(() => assertAnyLocalAsrInstalled([]), 'an empty catalog does not block');

storage.set('cc.asrModel', 'not-a-tier');
assert.equal(chooseAsrConfig(profile, null).modelTier, 'small', 'an unknown stored tier falls back to auto');

console.log('asr-model-tier-selection.verify: every catalog tier survives settings sync and runtime resolution');
console.log('asr-model-tier-selection.verify: auto resolves to an installed tier, and nothing installed is actionable');
