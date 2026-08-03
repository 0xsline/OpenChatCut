import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const testLocaleId = '\0asset-menu-destinations-test-locale';
const vite = await createServer({
  appType: 'custom',
  plugins: [{
    name: 'asset-menu-destinations-test-locale',
    enforce: 'pre',
    resolveId(id) {
      return id.endsWith('/i18n/locale') || id.endsWith('/i18n/locale.ts') ? testLocaleId : null;
    },
    load(id) {
      if (id !== testLocaleId) return null;
      return `
        export const t = (text, params) => params
          ? text.replace(/\\{(\\w+)\\}/g, (match, key) => key in params ? String(params[key]) : match)
          : text;
        export const useT = () => t;
      `;
    },
  }],
  server: { middlewareMode: true },
});

try {
  const { AssetMenuDestinations } = await vite.ssrLoadModule(
    '/src/media/AssetMenuDestinations.tsx',
  ) as typeof import('./AssetMenuDestinations');
  const { BlankMediaMenuActions } = await vite.ssrLoadModule(
    '/src/media/MediaPoolOverlays.tsx',
  ) as typeof import('./MediaPoolOverlays');
  const { runAssetDestinationAction } = await vite.ssrLoadModule(
    '/src/media/assetDestination.ts',
  ) as typeof import('./assetDestination');
  const { assetMenuSelectionIds, assetMenuFavoriteValue, batchAssetRename, duplicateAssetName } = await vite.ssrLoadModule(
    '/src/media/assetMenuSelection.ts',
  ) as typeof import('./assetMenuSelection');

  const calls: string[] = [];
  const actions = {
    timeline: () => calls.push('timeline'),
    chat: () => calls.push('chat'),
  };

  runAssetDestinationAction('timeline', actions);
  runAssetDestinationAction('chat', actions);
  assert.deepEqual(calls, ['timeline', 'chat']);
  assert.deepEqual(
    assetMenuSelectionIds('asset-b', new Set(['asset-a', 'asset-b']), ['asset-a', 'asset-b', 'asset-c']),
    ['asset-a', 'asset-b'],
    '右键已选素材必须保留整个多选集',
  );
  assert.equal(duplicateAssetName('项目素材.mp4', 'copy'), '项目素材 copy.mp4');
  assert.equal(duplicateAssetName('无扩展名', 'copy'), '无扩展名 copy');
  assert.deepEqual(
    assetMenuSelectionIds('asset-c', new Set(['asset-a', 'asset-b']), ['asset-a', 'asset-b', 'asset-c']),
    ['asset-c'],
    '右键未选素材必须只操作当前素材',
  );
  assert.equal(
    assetMenuFavoriteValue([{ favorite: true }, { favorite: false }]),
    true,
    '批量收藏只要其中一个未收藏，就应统一收藏',
  );
  assert.equal(
    assetMenuFavoriteValue([{ favorite: true }, { favorite: true }]),
    false,
    '批量取消收藏只在全部已收藏时发生',
  );
  assert.deepEqual(
    batchAssetRename([
      { id: 'asset-a', name: '原片.mp4' },
      { id: 'asset-b', name: '封面.png' },
    ], '项目素材'),
    [
      { id: 'asset-a', name: '项目素材.mp4' },
      { id: 'asset-b', name: '项目素材 2.png' },
    ],
    '批量重命名必须保留各素材扩展名，并给后续素材添加稳定序号',
  );

  const markup = renderToStaticMarkup(createElement(AssetMenuDestinations, {
    assetName: '7月7日.mp4',
    onAddTimeline: () => undefined,
    onAddChat: () => undefined,
  }));

  assert.match(markup, /添加到：/);
  assert.match(markup, />时间线</);
  assert.match(markup, />AI 对话框</);
  assert.ok(markup.indexOf('>AI 对话框<') < markup.indexOf('>时间线<'), 'AI 对话框应位于左侧，时间线应位于右侧');
  assert.match(markup, /aria-label="添加 7月7日.mp4 到时间线"/);
  assert.match(markup, /aria-label="添加 7月7日.mp4 到 AI 对话框"/);

  const blankMenuMarkup = renderToStaticMarkup(createElement(BlankMediaMenuActions, {
    clipboardCount: 2,
    visibleCount: 3,
    allVisibleSelected: false,
    view: 'grid',
    sort: 'newest',
    type: 'all',
    onPaste: () => undefined,
    onSelectAll: () => undefined,
    onUpload: () => undefined,
    onSemanticSearch: () => undefined,
    onMobileUpload: () => undefined,
    onCreateFolder: () => undefined,
    onViewToggle: () => undefined,
    onSort: () => undefined,
    onType: () => undefined,
  }));
  assert.match(blankMenuMarkup, /粘贴副本 \(2\)/);
  assert.match(blankMenuMarkup, />全选</);
  assert.match(blankMenuMarkup, />上传素材</);
  assert.match(blankMenuMarkup, />本地语义搜索</);
  assert.match(blankMenuMarkup, />手机传素材</);
  assert.match(blankMenuMarkup, />新建文件夹</);
  assert.match(blankMenuMarkup, /aria-label="素材排序"/);
  assert.match(blankMenuMarkup, /aria-label="筛选素材"/);

  const overlaySource = await readFile(new URL('./MediaPoolOverlays.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(overlaySource, /className="cc-asset-menu-backdrop"/, '素材菜单不应使用全屏遮罩阻断直接右键另一素材');
  assert.match(overlaySource, /document\.addEventListener\('pointerdown', closeOutside, true\)/, '素材菜单应通过外部点击关闭');
} finally {
  await vite.close();
}

console.log('asset menu destinations verified');
