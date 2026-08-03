import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediaRatioLabel } from './mediaPoolFormat';

assert.equal(mediaRatioLabel(1920, 1080), '16:9');
assert.equal(mediaRatioLabel(1080, 1920), '9:16');
assert.equal(mediaRatioLabel(1024, 768), '4:3');
assert.equal(mediaRatioLabel(undefined, 1080), null);
assert.equal(mediaRatioLabel(1920, 0), null);

const cardSource = readFileSync(new URL('./MediaPoolCard.tsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

assert.match(
  cardSource,
  /const aspectLabel = mediaRatioLabel\(asset\.width, asset\.height\);[\s\S]*?className="cc-asset-ratio"/,
  '素材卡片应根据自身宽高渲染比例角标',
);
assert.match(
  cssSource,
  /\.cc-asset-ratio\s*\{[^}]*position:\s*absolute;[^}]*left:\s*4px;[^}]*bottom:\s*4px;/s,
  '素材比例应固定在缩略图左下角',
);
assert.match(
  cssSource,
  /\.cc-media-grid\.list[\s\S]*?\.cc-asset-ratio[\s\S]*?display:\s*none;/,
  '列表模式应隐藏缩略图比例角标',
);

console.log('media-aspect-badge.verify: valid visual media ratios render at thumbnail bottom-left');
