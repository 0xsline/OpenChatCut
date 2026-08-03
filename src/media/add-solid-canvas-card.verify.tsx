import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddSolidCanvasCard } from './AddSolidCanvasCard';

const markup = renderToStaticMarkup(
  <AddSolidCanvasCard label="添加纯色背景/画布" onAdd={() => undefined} />,
);

assert.match(
  markup,
  /class="cc-add-solid-canvas-card"/,
  '我的素材网格第一格应提供添加纯色背景/画布快捷卡片',
);
assert.match(markup, />添加纯色背景\/画布</, '快捷卡片应显示明确操作名称');
assert.match(markup, /aria-label="添加纯色背景\/画布"/, '整张卡片应是可访问的添加操作');

console.log('add-solid-canvas-card.verify: first-grid action card OK');
