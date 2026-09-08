import assert from 'node:assert/strict';
import { DESKTOP_UI_SCALE_BASE } from './window-scale.ts';
import { DESKTOP_UI_SCALE_BASE_KEY, migrateUiScaleBase, rebaseUiScale } from './ui-scale-migration.ts';

assert.equal(DESKTOP_UI_SCALE_BASE, 1.1, 'the shipped density is the former 110%');

// Conversion from the original base: the size the user saw is preserved as closely as
// the Settings steps allow, and 110% — the value that motivated the change — lands on 100%.
assert.equal(rebaseUiScale(1.1, 1, 1.1), 1, 'a saved 110% is the new 100%');
assert.equal(rebaseUiScale(1, 1, 1.1), 0.9, 'an explicit 100% keeps its size as 90% (0.99×)');
assert.equal(rebaseUiScale(1.25, 1, 1.1), 1.1);
assert.equal(rebaseUiScale(1.5, 1, 1.1), 1.25);
assert.equal(rebaseUiScale(0.9, 1, 1.1), 0.8);
assert.equal(rebaseUiScale(0.8, 1, 1.1), 0.8, 'the floor stays the floor');
assert.equal(rebaseUiScale(1.25, 1.1, 1.1), 1.25, 'the same base is the identity');

function fakeStore(initial: Record<string, string>) {
  const data: Record<string, string> = { ...initial };
  const writes: Array<Record<string, string>> = [];
  return {
    data,
    writes,
    getKey: (name: string) => data[name] ?? '',
    setKeys: async (patch: Record<string, string>) => {
      writes.push(patch);
      Object.assign(data, patch);
    },
  };
}

// A legacy saved scale is rebased and the base is recorded.
{
  const store = fakeStore({ UI_SCALE: '1.1' });
  assert.deepEqual(await migrateUiScaleBase(store), { from: 1.1, to: 1 });
  assert.equal(store.data.UI_SCALE, '1');
  assert.equal(store.data[DESKTOP_UI_SCALE_BASE_KEY], '1.1');
  assert.equal(store.writes.length, 1, 'one write carries both keys');
  assert.equal(await migrateUiScaleBase(store), null, 'a second start is a no-op');
  assert.equal(store.writes.length, 1, 'and writes nothing');
}

// No saved scale: the user gets the new default, and only the base is recorded.
{
  const store = fakeStore({});
  assert.equal(await migrateUiScaleBase(store), null);
  assert.equal(store.data.UI_SCALE, undefined, 'no scale is invented');
  assert.equal(store.data[DESKTOP_UI_SCALE_BASE_KEY], '1.1');
}

// A scale saved under some other recorded base is converted from that base.
{
  const store = fakeStore({ UI_SCALE: '1.25', [DESKTOP_UI_SCALE_BASE_KEY]: '1.375' });
  assert.deepEqual(await migrateUiScaleBase(store), { from: 1.25, to: 1.5 }, '1.25 × 1.375 / 1.1 = 1.5625 → 1.5');
}

// Garbage is left alone rather than turned into a number.
{
  const store = fakeStore({ UI_SCALE: 'large' });
  assert.equal(await migrateUiScaleBase(store), null);
  assert.equal(store.data.UI_SCALE, 'large');
  assert.equal(store.data[DESKTOP_UI_SCALE_BASE_KEY], '1.1');
}

console.log('ui-scale-migration.verify: ok');
