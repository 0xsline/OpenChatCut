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

console.log('media-folder-drop.verify: placeholder and ready preserve the target folder');
