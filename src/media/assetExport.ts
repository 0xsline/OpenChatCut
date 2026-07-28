import type { MediaAsset, TimelineItem, TimelineState } from '../editor/types';
import { t } from '../i18n/locale';
import { exportClipMov } from './clipExport';
import { sanitizeFileName } from './fileName';

const DEFAULT_CANVAS = { width: 1920, height: 1080 };
const FILE_EXTENSION = /\.[a-z0-9]{1,8}$/i;

export function mediaAssetDownloadName(asset: MediaAsset): string {
  const name = sanitizeFileName(asset.name, 'asset');
  if (FILE_EXTENSION.test(name)) return name;
  const extension = new URL(asset.src, window.location.href).pathname.match(FILE_EXTENSION)?.[0] ?? '';
  return `${name}${extension}`;
}

export function motionGraphicExport(asset: MediaAsset, fps: number): { state: TimelineState; item: TimelineItem } {
  if (asset.kind !== 'motion-graphic' || !asset.code) throw new Error(t('MG 素材缺少动画代码'));
  const width = asset.width && asset.width > 0 ? asset.width : DEFAULT_CANVAS.width;
  const height = asset.height && asset.height > 0 ? asset.height : DEFAULT_CANVAS.height;
  const durationInFrames = asset.durationInFrames > 0 ? Math.round(asset.durationInFrames) : Math.round(fps * 3);
  const item: TimelineItem = {
    id: `asset-export-${asset.id}`, track: 'V1', startFrame: 0, durationInFrames,
    name: asset.name, kind: 'motion-graphic', templateId: asset.id,
    code: asset.code, props: { ...asset.props }, width, height,
  };
  return { state: { fps, width, height, items: [item], selectedId: null }, item };
}

export async function exportMediaAsset(asset: MediaAsset, fps: number): Promise<void> {
  if (asset.kind === 'motion-graphic') {
    const { state, item } = motionGraphicExport(asset, fps);
    await exportClipMov(state, item);
    return;
  }
  const url = new URL(asset.src, window.location.href);
  const localHttp = (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === window.location.origin;
  if (!localHttp && url.protocol !== 'blob:' && url.protocol !== 'data:') throw new Error(t('素材地址无效'));
  const anchor = document.createElement('a');
  anchor.href = url.href;
  anchor.download = mediaAssetDownloadName(asset);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
