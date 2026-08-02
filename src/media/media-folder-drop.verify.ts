import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8');
const grid = readFileSync(new URL('./MediaPoolGrid.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('./MediaPoolCard.tsx', import.meta.url), 'utf8');

assert.match(panel, /onPick\(event\.dataTransfer\.files, currentFolderId\)/, '素材池空白处拖入文件必须进入当前文件夹');
assert.match(panel, /onMoveAssets\(\[imported\.id\], targetFolderId\)/, '上传完成后必须把素材归入目标文件夹');
assert.match(grid, /onDropFiles=\{props\.onDropFiles\}/, '虚拟网格必须把文件拖放处理传给文件夹卡片');
assert.match(card, /event\.dataTransfer\.files\.length[\s\S]*onDropFiles\(event\.dataTransfer\.files, folder\.id\)/, '拖到文件夹的本机文件必须导入该文件夹');
assert.match(card, /parseMediaAssetDrag\(event\)[\s\S]*onMoveAsset\(assetId, folder\.id\)/, '拖到文件夹的池内素材必须移动到该文件夹');

console.log('media-folder-drop.verify: imports and pool assets route to the target folder');
