// Runnable: `npx tsx src/media/media-folder-menu.verify.ts`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const card = readFileSync(new URL('./MediaPoolCard.tsx', import.meta.url), 'utf8');
const overlays = readFileSync(new URL('./MediaPoolOverlays.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8');
const grid = readFileSync(new URL('./MediaPoolGrid.tsx', import.meta.url), 'utf8');

assert.match(card, /onContextMenu/, '文件夹卡片必须响应右键');
assert.match(card, /onOpenMenu/, '文件夹卡片必须暴露菜单入口');
assert.match(card, /cc-folder-more/, '文件夹卡片应有 ⋯ 按钮');
assert.match(overlays, /export function FolderMenuPortal/, '必须有文件夹菜单 portal');
assert.match(overlays, /只能删除空文件夹/, '非空文件夹删除应禁用并提示');
assert.match(panel, /FolderMenuPortal/, '素材池面板必须挂载文件夹菜单');
assert.match(panel, /onOpenFolderMenu/, '网格必须接收文件夹菜单回调');
assert.match(grid, /onOpenFolderMenu/, '网格必须把文件夹菜单传给卡片');
assert.match(panel, /currentFolderId === deleteState\.id/, '删除非当前文件夹时不得跳转导航');

console.log('media-folder-menu.verify: ok (右键/⋯/portal/空文件夹删除/导航)');
