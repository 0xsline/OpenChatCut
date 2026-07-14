// Runnable check for ProjectDoc V2 migration + project-wide media assets:
// `npx tsx src/persist/projectStore.check.ts`.
import assert from 'node:assert';
import { projectReduce } from '../editor/reduce';
import { makeDraft } from '../editor/store';
import { activeEditorState, type MediaAsset, type Timeline } from '../editor/types';
import { docFromTimeline, migrateProjectDoc } from './projectStore';

const assetA: MediaAsset = {
  id: 'asset_a', name: 'a.mp4', kind: 'video', src: '/a.mp4', durationInFrames: 90,
};
const assetB: MediaAsset = {
  id: 'asset_b', name: 'b.png', kind: 'image', src: '/b.png', durationInFrames: 150,
};
const motionAsset: MediaAsset = {
  id: 'asset_mg', name: 'Title', kind: 'motion-graphic', src: '', durationInFrames: 90,
  code: 'const Title = () => null;', props: { title: 'Hello' }, width: 1920, height: 1080,
};
const timeline = (id: string, assets?: MediaAsset[]): Timeline => ({
  id, name: id, order: id === 'tl_a' ? 0 : 1,
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null,
  ...(assets ? { assets } : {}),
});

// Legacy multi-timeline docs stored a separate media pool on each timeline.
const migrated = migrateProjectDoc({
  timelines: [timeline('tl_a', [assetA]), timeline('tl_b', [assetA, assetB])],
  activeTimelineId: 'missing',
});
assert.ok(migrated, 'legacy project migrates');
assert.strictEqual(migrated.version, 2, 'migration stamps V2');
assert.deepStrictEqual(migrated.mediaFolders, [], 'legacy project gets an empty folder list');
assert.deepStrictEqual(migrated.assets.map((asset) => asset.id), ['asset_a', 'asset_b'], 'assets merge and dedupe by id');
assert.strictEqual(migrated.activeTimelineId, 'tl_a', 'stale active id falls back to first timeline');
assert.ok(migrated.timelines.every((item) => !Object.hasOwn(item, 'assets')), 'timeline copies are removed');

// A legacy single-timeline state is wrapped and its media moves to the project.
const wrapped = docFromTimeline({
  fps: 30, width: 1080, height: 1920, items: [], selectedId: null, assets: [assetA],
});
assert.deepStrictEqual(wrapped.assets, [assetA]);
assert.ok(!Object.hasOwn(wrapped.timelines[0], 'assets'));
assert.deepStrictEqual(docFromTimeline({
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [motionAsset],
}).assets, [motionAsset], 'motion graphics survive project migration');
const motionDraft = makeDraft(docFromTimeline({
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null,
}));
motionDraft.commands.addMediaItem(motionAsset, { startFrame: 12 });
const motionItem = motionDraft.getState().items[0];
assert.strictEqual(motionItem.kind, 'motion-graphic');
assert.strictEqual(motionItem.startFrame, 12);
assert.strictEqual(motionItem.templateId, motionAsset.id);
assert.strictEqual(motionItem.code, motionAsset.code);
assert.deepStrictEqual(motionItem.props, motionAsset.props, 'media-pool insertion keeps executable template data');

// New imports mutate the project, remain idempotent, and survive timeline ops.
const withAsset = projectReduce(migrated, { type: 'addAsset', asset: assetB });
assert.strictEqual(withAsset, migrated, 'duplicate asset import is idempotent');
const assetC: MediaAsset = {
  id: 'asset_c', name: 'c.mp3', kind: 'audio', src: '/c.mp3', durationInFrames: 300,
};
const added = projectReduce(migrated, { type: 'addAsset', asset: assetC });
const created = projectReduce(added, { type: 'tl.create', timeline: timeline('tl_c') });
const switched = projectReduce(created, { type: 'tl.switch', id: 'tl_b' });
assert.deepStrictEqual(switched.assets.map((asset) => asset.id), ['asset_a', 'asset_b', 'asset_c']);
assert.deepStrictEqual(activeEditorState(switched).assets, switched.assets, 'every active timeline sees shared assets');
assert.ok(switched.timelines.every((item) => !Object.hasOwn(item, 'assets')), 'shared assets never leak into timelines');

// Media-pool organization is project-level and guarded against deleting non-empty bins.
const folder = { id: 'bin_a', name: 'B-roll' };
const organized = projectReduce(projectReduce(switched, { type: 'pool.createFolder', folder }), { type: 'pool.moveAssets', ids: ['asset_a'], folderId: folder.id });
assert.strictEqual(organized.assets.find((asset) => asset.id === 'asset_a')?.folderId, folder.id);
assert.strictEqual(projectReduce(organized, { type: 'pool.deleteFolder', id: folder.id }), organized, 'non-empty folder cannot be deleted');
const favorited = projectReduce(organized, { type: 'pool.updateAsset', id: 'asset_a', patch: { favorite: true, name: 'Hero' } });
assert.deepStrictEqual(favorited.assets.find((asset) => asset.id === 'asset_a'), { ...assetA, folderId: folder.id, favorite: true, name: 'Hero' });

console.log('projectStore.check: ok');
