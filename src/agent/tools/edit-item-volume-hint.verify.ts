import assert from 'node:assert/strict';
import {
  hasClipLevelUpdateFields,
  rejectUnknownFields,
  resolveUpdateType,
  shouldCoerceEffectUpdateToClip,
} from './edit-item-fields';
import { GENERIC_ITEM_KINDS, validateGenericUpdate } from './edit-item-generic';
import type { TimelineState } from '../../editor/types';

const state = {
  items: [
    {
      id: 'a0_bgm', kind: 'audio', track: 'A1', startFrame: 0, durationInFrames: 300,
      name: '背景音乐', src: '/media/uploads/x.wav', volume: 1,
    },
    {
      id: 'v0_main', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 300,
      name: '主画面', src: '/media/uploads/x.mp4', volume: 1,
    },
  ],
  fps: 30, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V1', 'A1'], tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
} as unknown as TimelineState;

// Pure type resolution (no .frag import chain)
assert.equal(
  resolveUpdateType({ itemId: 'a0', volume: 0.3 }, 'audio', GENERIC_ITEM_KINDS),
  'audio',
  'omitted type + volume → audio',
);
assert.equal(
  resolveUpdateType({ type: 'effect', itemId: 'a0', volume: 0.3 }, 'audio', GENERIC_ITEM_KINDS),
  'effect',
  'explicit type is kept for resolve; coerce happens separately',
);
assert.equal(
  resolveUpdateType({ effectId: 'fx_1', propertyOverrides: { intensity: 1 } }, undefined, GENERIC_ITEM_KINDS),
  'effect',
);
assert.equal(hasClipLevelUpdateFields({ volume: 0.3 }), true);
assert.equal(shouldCoerceEffectUpdateToClip(
  { type: 'effect', itemId: 'a0', volume: 0.3 },
  'effect',
  'audio',
  GENERIC_ITEM_KINDS,
), true);
assert.equal(shouldCoerceEffectUpdateToClip(
  { type: 'effect', effectId: 'fx_1', propertyOverrides: { a: 1 } },
  'effect',
  'video',
  GENERIC_ITEM_KINDS,
), false, 'real effect rows must not coerce');

// Generic update path (same module as production commit)
{
  const r = validateGenericUpdate(state, { type: 'audio', itemId: 'a0_bgm', volume: 0.3 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.volume, 0.3);
  assert.equal(r.plan, 'genericUpdate');
}
{
  // Coerced payload shape after validateUpdate rewrite
  const r = validateGenericUpdate(state, { type: 'audio', itemId: 'a0_bgm', volume: 0.3 });
  assert.equal(r.kind, 'audio');
}

// Error copy for effect + volume
{
  const msg = rejectUnknownFields(
    { type: 'effect', targetItemId: 'v0', id: 'fx_1', volume: 0.5 },
    { type: true, targetItemId: true, id: true, effectId: true, assetId: true, propertyOverrides: true },
    { specializedType: 'effect' },
  );
  assert.match(String(msg ?? ''), /type:"audio"/);
  assert.match(String(msg ?? ''), /volume/);
  assert.match(String(msg ?? ''), /generic update/i);
}

console.log('edit-item-volume-hint.verify: ok');
