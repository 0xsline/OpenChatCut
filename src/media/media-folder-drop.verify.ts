import assert from 'node:assert/strict';
import type { MediaAsset } from '../editor/types';
import { importMediaBatch } from './mediaPoolImport';

const targetFolderId = 'folder-travel';
const placeholder = { id: 'asset-1', name: 'trip.mov' } as MediaAsset;
const ready = { ...placeholder, src: '/media/trip.mov' } as MediaAsset;
const placements: Array<{ ids: string[]; folderId?: string }> = [];

const errors = await importMediaBatch({
  files: [{ name: 'trip.mov' } as File],
  targetFolderId,
  onImport: async (_file, _onProgress, lifecycle) => {
    lifecycle?.onPlaceholder?.(placeholder);
    assert.deepEqual(placements.at(-1), { ids: ['asset-1'], folderId: targetFolderId },
      'placeholder 必须立即归入拖放目标文件夹');
    lifecycle?.onAssetUpdated?.(ready);
    assert.deepEqual(placements.at(-1), { ids: ['asset-1'], folderId: targetFolderId },
      'ready 素材必须再次确认拖放目标文件夹');
    return ready;
  },
  onMoveAssets: (ids, folderId) => placements.push({ ids, folderId }),
  onProgress: () => undefined,
});

assert.deepEqual(errors, [], '成功导入不应产生批次错误');
assert.deepEqual(placements, [
  { ids: ['asset-1'], folderId: targetFolderId },
  { ids: ['asset-1'], folderId: targetFolderId },
], 'placeholder 与 ready 两个阶段必须归入同一个拖放目标文件夹');

const nestedPlacements: Array<{ ids: string[]; folderId?: string }> = [];
await importMediaBatch({
  files: [{ name: 'day-1.mov' } as File, { name: 'day-2.mov' } as File],
  targetFolderIds: ['folder-day-1', 'folder-day-2'],
  onImport: async (file) => ({ id: file.name, name: file.name }) as MediaAsset,
  onMoveAssets: (ids, folderId) => nestedPlacements.push({ ids, folderId }),
  onProgress: () => undefined,
});
assert.deepEqual(nestedPlacements, [
  { ids: ['day-1.mov'], folderId: 'folder-day-1' },
  { ids: ['day-2.mov'], folderId: 'folder-day-2' },
], '每个素材必须保留导入目录中的文件夹层级');

console.log('media-folder-drop.verify: placeholder and ready preserve the target folder');
