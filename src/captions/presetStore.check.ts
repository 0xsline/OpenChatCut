// Check for the caption preset store (memory fallback under node — no indexedDB). Run:
//   tsx src/captions/presetStore.check.ts
import assert from 'node:assert';
import {
  listCaptionPresets, saveCaptionPreset, deleteCaptionPreset, resolveCaptionPreset, __resetCaptionPresetMemory,
  type CaptionPreset,
} from './presetStore';

const p = (id: string, name: string, createdAt: number): CaptionPreset => ({
  id, name, template: 'tiktok', styleOverride: { color: '#fff' }, createdAt,
});

await (async () => {
  __resetCaptionPresetMemory();
  assert.deepEqual(await listCaptionPresets(), [], 'starts empty');

  // save two — list is createdAt-ordered
  await saveCaptionPreset(p('cp_b', 'Second', 200));
  await saveCaptionPreset(p('cp_a', 'First', 100));
  const list = await listCaptionPresets();
  assert.deepEqual(list.map((x) => x.name), ['First', 'Second'], 'ordered by createdAt');
  assert.deepEqual(list[0].styleOverride, { color: '#fff' }, 'style round-trips');

  // resolve by exact id, id prefix, and name
  assert.equal((await resolveCaptionPreset('cp_a'))?.name, 'First', 'resolve exact id');
  assert.equal((await resolveCaptionPreset('cp_b'))?.name, 'Second', 'resolve id');
  assert.equal((await resolveCaptionPreset('Second'))?.id, 'cp_b', 'resolve by name');
  assert.equal(await resolveCaptionPreset('missing'), undefined, 'unknown → undefined');
  assert.equal(await resolveCaptionPreset(''), undefined, 'empty → undefined');

  // rename == put same id with new name (no dup)
  const first = (await resolveCaptionPreset('cp_a'))!;
  await saveCaptionPreset({ ...first, name: 'Renamed' });
  const afterRename = await listCaptionPresets();
  assert.equal(afterRename.length, 2, 'rename does not duplicate');
  assert.equal((await resolveCaptionPreset('cp_a'))?.name, 'Renamed', 'renamed');

  // delete
  await deleteCaptionPreset('cp_a');
  const afterDel = await listCaptionPresets();
  assert.deepEqual(afterDel.map((x) => x.id), ['cp_b'], 'deleted cp_a');

  __resetCaptionPresetMemory();
  console.log('presetStore.check.ts OK');
})();
