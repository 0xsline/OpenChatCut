import assert from 'node:assert/strict';
import {
  setVadSilenceRemovalPreference,
  storedVadSilenceRemoval,
  vadSilenceRemovalEnabled,
  VAD_SILENCE_REMOVAL_KEY,
} from './vadPreference';

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function memoryStorage(initial: Record<string, string> = {}): FakeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
  };
}

const unchosen = memoryStorage();
const optedIn = memoryStorage({ [VAD_SILENCE_REMOVAL_KEY]: '1' });
const optedOut = memoryStorage({ [VAD_SILENCE_REMOVAL_KEY]: '0' });

// No choice + no build flag: destructive silence removal stays off.
assert.equal(storedVadSilenceRemoval(unchosen), undefined);
assert.equal(vadSilenceRemovalEnabled(unchosen, undefined), false);

// Builds that shipped the flag keep their behaviour while the user has not chosen.
assert.equal(vadSilenceRemovalEnabled(unchosen, 'true'), true);
assert.equal(vadSilenceRemovalEnabled(unchosen, '1'), true);
assert.equal(vadSilenceRemovalEnabled(unchosen, true), true);
assert.equal(vadSilenceRemovalEnabled(unchosen, 'false'), false, 'only the truthy shapes enable the feature');

// The stored choice wins in both directions.
assert.equal(vadSilenceRemovalEnabled(optedIn, undefined), true, 'opt-in works without a build flag');
assert.equal(vadSilenceRemovalEnabled(optedOut, 'true'), false, 'opt-out overrides an enabling build flag');

// Malformed storage is "not chosen", never silently enabled.
for (const junk of ['yes', 'true', '', '2', 'null']) {
  const store = memoryStorage({ [VAD_SILENCE_REMOVAL_KEY]: junk });
  assert.equal(storedVadSilenceRemoval(store), undefined, `malformed value ${junk} is not a choice`);
  assert.equal(vadSilenceRemovalEnabled(store, undefined), false);
}

// Writer round trip.
const store = memoryStorage();
setVadSilenceRemovalPreference(true, store);
assert.equal(store.data[VAD_SILENCE_REMOVAL_KEY], '1');
assert.equal(vadSilenceRemovalEnabled(store, undefined), true);
setVadSilenceRemovalPreference(false, store);
assert.equal(store.data[VAD_SILENCE_REMOVAL_KEY], '0');
assert.equal(vadSilenceRemovalEnabled(store, undefined), false);

// A throwing storage implementation breaks neither reads nor writes, and the
// build default still decides.
const hostile: FakeStorage = {
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('storage blocked'); },
};
assert.equal(storedVadSilenceRemoval(hostile), undefined);
setVadSilenceRemovalPreference(true, hostile);
assert.equal(vadSilenceRemovalEnabled(hostile, undefined), false);
assert.equal(vadSilenceRemovalEnabled(hostile, 'true'), true);

console.log('vadPreference.verify: ok');
