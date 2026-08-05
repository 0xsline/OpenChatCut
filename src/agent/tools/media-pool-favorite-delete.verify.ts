import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execMediaPoolTool } from './media-pool-tools';

const assets: MediaAsset[] = [
  { id: 'asset_a', name: 'a.mp4', kind: 'video', src: '/a.mp4', durationInFrames: 90 },
  { id: 'asset_b', name: 'b.mp4', kind: 'video', src: '/b.mp4', durationInFrames: 60 },
];
const base = docFromTimeline({
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets,
});
const draft = makeDraft(base);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

assert.deepEqual(
  await execMediaPoolTool('manage_media_pool', { action: 'favorite_assets', assetIds: 'asset_a,asset_b' }, ctx),
  { ok: true, favorite: true, assetIds: ['asset_a', 'asset_b'] },
);
assert.equal(draft.getDoc().assets.every((asset) => asset.favorite === true), true);

assert.deepEqual(
  await execMediaPoolTool('manage_media_pool', { action: 'unfavorite_assets', assetIds: 'asset_a' }, ctx),
  { ok: true, favorite: false, assetIds: ['asset_a'] },
);
assert.equal(draft.getDoc().assets.find((asset) => asset.id === 'asset_a')?.favorite, false);

// Unreferenced delete is immediate.
assert.deepEqual(
  await execMediaPoolTool('manage_media_pool', { action: 'delete_assets', assetIds: 'asset_b' }, ctx),
  { ok: true, deleted: ['asset_b'], wasReferenced: [] },
);
assert.equal(draft.getDoc().assets.some((asset) => asset.id === 'asset_b'), false);

// Referenced asset needs confirm when a timeline clip shares its src.
const linked: MediaAsset = { id: 'asset_c', name: 'c.mp4', kind: 'video', src: '/c.mp4', durationInFrames: 30 };
draft.commands.addAsset(linked);
// Seed a clip that references the asset src (pool delete should not require the clip gone).
const withClip = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [linked],
  items: [{
    id: 'clip_c',
    kind: 'video',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 30,
    name: 'c',
    src: '/c.mp4',
  }],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
}));
const clipCtx: AgentContext = {
  commands: withClip.commands,
  getState: withClip.getState,
  getDoc: withClip.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};
const needs = await execMediaPoolTool('manage_media_pool', { action: 'delete_assets', assetIds: 'asset_c' }, clipCtx) as {
  needsConfirm?: boolean;
};
assert.equal(needs.needsConfirm, true, JSON.stringify(needs));
const deleted = await execMediaPoolTool(
  'manage_media_pool',
  { action: 'delete_assets', assetIds: 'asset_c', confirm: true },
  clipCtx,
) as { ok?: boolean; deleted?: string[] };
assert.equal(deleted.ok, true);
assert.deepEqual(deleted.deleted, ['asset_c']);
assert.equal(withClip.getDoc().assets.some((asset) => asset.id === 'asset_c'), false);

console.log('media-pool-favorite-delete.verify: ok');
