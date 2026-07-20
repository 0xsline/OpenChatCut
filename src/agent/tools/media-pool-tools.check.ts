// Runnable contract check: `npx tsx src/agent/media-pool-tools.check.ts`.
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import type { MediaAsset } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execMediaPoolTool } from './media-pool-tools';

const asset: MediaAsset = { id: 'asset_hero', name: 'hero.mp4', kind: 'video', src: '/hero.mp4', durationInFrames: 90 };
const base = docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [asset] });
const draft = makeDraft(base);
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

const created = await execMediaPoolTool('manage_media_pool', { action: 'create_folder', name: 'B-roll' }, ctx) as { folder: { id: string } };
assert.ok(created.folder.id);
assert.deepStrictEqual(await execMediaPoolTool('manage_media_pool', { action: 'move_assets', assetIds: 'asset_hero', targetPath: 'Master/B-roll' }, ctx), {
  ok: true, moved: ['asset_hero'], target: 'Master/B-roll',
});
assert.deepStrictEqual(await execMediaPoolTool('manage_media_pool', { action: 'delete_empty_folder', folderPath: 'Master/B-roll' }, ctx), { error: 'folder is not empty' });
await execMediaPoolTool('manage_media_pool', { action: 'rename_asset', assetIds: 'asset_hero', newName: 'Hero shot' }, ctx);
await execMediaPoolTool('manage_media_pool', { action: 'move_assets', assetIds: 'asset_hero', targetPath: 'Master' }, ctx);
assert.deepStrictEqual(await execMediaPoolTool('manage_media_pool', { action: 'delete_empty_folder', folderPath: created.folder.id.slice(0, 12) }, ctx), { ok: true, deleted: 'Master/B-roll' });
assert.strictEqual(draft.getDoc().assets[0].name, 'Hero shot');
assert.strictEqual(draft.getDoc().mediaFolders.length, 0);

console.log('media-pool-tools.check: ok');
