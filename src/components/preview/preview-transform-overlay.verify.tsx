import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerRef } from '@remotion/player';
import type { RefObject } from 'react';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { t } from '../../i18n/locale';
import { PreviewTransformOverlay } from './PreviewTransformOverlay';
import { fitPreviewCanvasSize } from './previewCanvasGeometry';

const item: TimelineItem = {
  id: 'card',
  track: 'V2',
  startFrame: 0,
  durationInFrames: 90,
  kind: 'motion-graphic',
  name: '金句卡片',
  width: 1080,
  height: 1920,
  transform: { x: 5, y: -4, scale: 0.8, rotation: 8 },
};

const stateOf = (trackPatch: Record<string, unknown> = {}, selectedId: string | null = 'card'): TimelineState => ({
  fps: 30,
  width: 1080,
  height: 1920,
  fit: 'contain',
  selectedId,
  selectedIds: selectedId ? [selectedId] : [],
  trackOrder: ['V2'],
  tracks: { V2: { kind: 'video', ...trackPatch } },
  items: [item],
});

const playerRef = {
  current: { getCurrentFrame: () => 20, pause: () => undefined } as unknown as PlayerRef,
} as RefObject<PlayerRef | null>;

const props = {
  playerRef,
  onSelectItem: () => undefined,
  onSetItemTransform: () => undefined,
  onSetItemKeyframe: () => undefined,
  onBeginHistoryGesture: () => undefined,
  onEndHistoryGesture: () => undefined,
};

// The canvas wrapper itself must be the contained composition rect. All
// interactive overlays are inset:0 children of this wrapper, so keeping its
// aspect is what makes caption hit boxes and clip handles share one coordinate
// space after an aspect switch.
assert.deepEqual(
  fitPreviewCanvasSize(
    { width: 558, height: 770 },
    { width: 1920, height: 1080 },
  ),
  { width: 558, height: 313.875 },
  '16:9 应在竖向较高的预览栏中按宽度 contain，不能保留旧竖屏高度',
);
assert.deepEqual(
  fitPreviewCanvasSize(
    { width: 558, height: 770 },
    { width: 1080, height: 1080 },
  ),
  { width: 558, height: 558 },
  '1:1 应得到正方形命中层与编辑框',
);
assert.deepEqual(
  fitPreviewCanvasSize(
    { width: 900, height: 500 },
    { width: 1080, height: 1920 },
  ),
  { width: 281.25, height: 500 },
  '9:16 应在横向较宽的预览栏中按高度 contain',
);
const previewPanelSource = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(
  previewPanelSource,
  /fitPreviewCanvasSize\(stageSize,\s*\{\s*width:\s*state\.width,\s*height:\s*state\.height/s,
  '预览面板必须把 contain 后的同一画布尺寸交给播放器、字幕命中层和片段变换层',
);

// A selected editable clip exposes one compact transform frame and nine handles.
{
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={stateOf()} {...props} />);
  assert.ok(markup.includes(`aria-label="${t('预览画布片段变换')}"`));
  assert.match(markup, /data-preview-selection="card"/);
  assert.equal((markup.match(/data-preview-handle="scale-[0-3]"/g) ?? []).length, 4, '四个角都应可等比缩放');
  assert.equal((markup.match(/data-preview-handle="crop-[nsew]"/g) ?? []).length, 4, '四边中点应可裁切遮盖');
  assert.equal((markup.match(/data-preview-handle="rotate"/g) ?? []).length, 1, '顶部应有一个旋转手柄');
  assert.match(markup, /var\(--cc-accent\)/, '控制框颜色跟随当前皮肤强调色');
}

// Locked and hidden tracks can never expose writable controls.
for (const trackPatch of [{ locked: true }, { hidden: true }]) {
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={stateOf(trackPatch)} {...props} />);
  assert.doesNotMatch(markup, /data-preview-selection=/);
  assert.doesNotMatch(markup, /data-preview-handle=/);
}

// A timeline selection outside the current frame must not leave a stale box.
{
  const state = stateOf();
  state.items = [{ ...item, startFrame: 30 }];
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={state} {...props} />);
  assert.doesNotMatch(markup, /data-preview-selection=/);
}

// Window resize can briefly report a zero-size composition; controls stay hidden until geometry is valid.
{
  const state = stateOf();
  state.width = 0;
  state.height = 0;
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={state} {...props} />);
  assert.doesNotMatch(markup, /data-preview-selection=/);
  assert.doesNotMatch(markup, /data-preview-handle=/);
}

console.log('preview-transform-overlay.verify: ok (语义/皮肤/四角/四边裁切/旋转/锁定隐藏/帧范围)');
