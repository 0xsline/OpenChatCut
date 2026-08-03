import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8');
const grid = readFileSync(new URL('./MediaPoolGrid.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('./MediaPoolCard.tsx', import.meta.url), 'utf8');

assert.match(panel, /setFavoritesOnly\(true\)/, '收藏夹入口必须进入收藏视图');
assert.match(panel, /favoritesOnly \? ` \/ \$\{t\('收藏夹'\)\}`/, '收藏夹视图必须显示可返回的面包屑');
assert.match(grid, /kind: 'favorites'/, '虚拟素材网格必须包含收藏夹入口类型');
assert.match(grid, /cc-folder-card cc-favorites-folder/, '收藏夹必须复用文件夹卡片视觉');
assert.match(card, /className="cc-asset-favorite"/, '每张素材卡必须提供收藏按钮');
assert.match(card, /aria-pressed=\{!!asset\.favorite\}/, '收藏按钮必须公开当前状态');
assert.match(card, /onSetFavorite\(asset\.id, !asset\.favorite\)/, '收藏按钮必须切换素材 favorite 字段');
assert.doesNotMatch(card, /cc-asset-check/, '收藏星标应替代冗余选择勾选框');

console.log('media-favorites-folder.verify: folder and card favorite controls are wired');
