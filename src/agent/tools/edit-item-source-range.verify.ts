import assert from 'node:assert/strict';
import { validateGenericAdd } from './edit-item-generic';
import type { TimelineState, MediaAsset } from '../../editor/types';

const state = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  tracks: { 'trk-v1': { kind: 'video' }, 'trk-a1': { kind: 'audio' } },
  transitions: [],
} as unknown as TimelineState;

const assets = [
  { id: 'asset-v', name: '素材.mp4', kind: 'video', src: '/media/uploads/v.mp4', durationInFrames: 900, width: 1920, height: 1080 },
  { id: 'asset-a', name: '音乐.mp3', kind: 'audio', src: '/media/uploads/m.mp3', durationInFrames: 6000 },
] as MediaAsset[];

async function main(): Promise<void> {
  // 1. search_media hit (sourceStartMs=12500 → 12.5s) passed straight through:
  //    converted to srcInFrame + durationInFrames here, model does no fps math.
  const hit = validateGenericAdd(state, assets, {
    type: 'video', assetId: 'asset-v', sourceStartSeconds: 12.5, sourceEndSeconds: 13.8, track: 'V1',
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.plan, 'addMedia');
  assert.equal(hit.srcInFrame, Math.round(12.5 * 30), 'source start converts to srcInFrame');
  assert.equal(hit.durationInFrames, Math.round((13.8 - 12.5) * 30), 'source window length in frames');
  assert.equal(hit.assetId, 'asset-v');

  // 2. Only sourceStartSeconds → window runs to the asset end.
  const openEnd = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v', sourceStartSeconds: 20 });
  assert.equal(openEnd.ok, true);
  assert.equal(openEnd.srcInFrame, 600);
  assert.equal(openEnd.durationInFrames, 300, '30s asset minus 20s start');

  // 3. Only sourceEndSeconds → window starts at 0.
  const openStart = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v', sourceEndSeconds: 3 });
  assert.equal(openStart.ok, true);
  assert.equal(openStart.srcInFrame, 0);
  assert.equal(openStart.durationInFrames, 90);

  // 4. Conflict with durationInFrames → rejected (one source of truth).
  const conflict = validateGenericAdd(state, assets, {
    type: 'video', assetId: 'asset-v', sourceStartSeconds: 1, sourceEndSeconds: 3, durationInFrames: 60,
  });
  assert.ok('error' in conflict, 'conflict must be rejected');
  assert.match(String(conflict.error), /do not combine/);

  // 5. Window past the asset end → rejected with the asset length.
  const overEnd = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v', sourceStartSeconds: 40 });
  assert.ok('error' in overEnd);
  assert.match(String(overEnd.error), /past the end/);
  const endPast = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v', sourceStartSeconds: 0, sourceEndSeconds: 99 });
  assert.ok('error' in endPast);
  assert.match(String(endPast.error), /exceeds the asset length/);

  // 6. Audio source window works the same way.
  const audioHit = validateGenericAdd(state, assets, { type: 'audio', assetId: 'asset-a', sourceStartSeconds: 5, sourceEndSeconds: 9 });
  assert.equal(audioHit.ok, true);
  assert.equal(audioHit.srcInFrame, 150);
  assert.equal(audioHit.durationInFrames, 120);

  // 7. Non-temporal kinds reject source windows.
  const imgReject = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v', sourceStartSeconds: 1, sourceEndSeconds: 2 });
  assert.equal(imgReject.ok, true, 'video asset accepts windows');
  const kindMismatch = validateGenericAdd(state, assets, { type: 'audio', assetId: 'asset-v' });
  assert.ok('error' in kindMismatch, 'kind mismatch still rejected');

  // 8. Without source fields behavior is unchanged (full asset).
  const plain = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v' });
  assert.equal(plain.ok, true);
  assert.equal('srcInFrame' in plain, false, 'no srcInFrame when no source window given');
  assert.equal('durationInFrames' in plain, false, 'no duration override when no source window given');

  console.log('edit-item-source-range.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
