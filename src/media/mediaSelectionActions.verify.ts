import assert from 'node:assert/strict';
import { allVisibleAssetsSelected, toggleVisibleAssetSelection } from './mediaSelectionActions';

const visible = ['map', 'route', 'video'];

assert.equal(allVisibleAssetsSelected(new Set(['map', 'route', 'video', 'outside']), visible), true,
  '当前可见素材全部已选时，空白右键菜单应改为取消全选');
assert.deepEqual(
  [...toggleVisibleAssetSelection(new Set(['map', 'route', 'video', 'outside']), visible)].sort(),
  ['outside'],
  '取消全选只能移除当前可见素材，不能误清除其他文件夹或筛选外的选择',
);
assert.deepEqual(
  [...toggleVisibleAssetSelection(new Set(['map', 'outside']), visible)].sort(),
  ['map', 'outside', 'route', 'video'],
  '未全选时应补齐当前可见素材，同时保留已有的其他选择',
);

console.log('media selection actions verification passed');
