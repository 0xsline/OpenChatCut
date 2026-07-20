import type { TimelineItem } from '../../editor/types';
import { filmstripBackground, peaksPath, useClipPreview } from '../../media/clipPreview';

// 片段内的媒体预览层:视频轨显示缩略帧条与片段自身音轨的音波。
// 数据来自 /api/waveform、/api/filmstrip(见 src/media/clipPreview.ts);几何按
// srcIn/playbackRate/px 映射,所以裁剪、变速、时间线缩放后帧与波都对得上位置。
// 层在标签之下(z-index 0),不拦指针,拖拽/裁剪手感不变。

const STRIP_RATIO = 0.62; // 有声视频:上 62% 帧条,下 38% 音波

export function ClipMediaLayers({ item, px, fps, height }: {
  item: TimelineItem;
  px: number;
  /** 片段内容区高度(px),音波路径按它算振幅 */
  height: number;
  fps: number;
}) {
  const preview = useClipPreview(item.src, item.kind);
  if (!preview || height <= 0) return null;

  const srcInFrame = item.srcInFrame ?? 0;
  const playbackRate = item.playbackRate ?? 1;
  const widthPx = Math.max(1, item.durationInFrames * px);
  const isVideo = item.kind === 'video';
  const strip = isVideo ? filmstripBackground(preview, { px, fps, srcInFrame, playbackRate }) : null;
  const hasWave = preview.peaks.length > 0;
  const waveH = strip && hasWave ? Math.max(6, height * (1 - STRIP_RATIO)) : height;
  const d = hasWave
    ? peaksPath(preview, { widthPx, height: waveH, fps, srcInFrame, durationInFrames: item.durationInFrames, playbackRate })
    : '';

  return (
    <>
      {strip && (
        <div
          aria-hidden
          style={{
            position: 'absolute', left: 0, right: 0, top: 0,
            height: hasWave ? `${STRIP_RATIO * 100}%` : '100%',
            zIndex: 0, pointerEvents: 'none', overflow: 'hidden', opacity: 0.92,
            backgroundRepeat: 'no-repeat',
            ...strip,
          }}
        />
      )}
      {d && (
        <svg
          aria-hidden
          className={`cc-clip-wave${isVideo ? ' on-video' : ''}`}
          viewBox={`0 0 ${widthPx.toFixed(1)} ${waveH.toFixed(1)}`}
          preserveAspectRatio="none"
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0, height: strip ? `${(1 - STRIP_RATIO) * 100}%` : '100%',
            zIndex: 0, pointerEvents: 'none', overflow: 'hidden',
          }}
        >
          <path d={d} />
        </svg>
      )}
    </>
  );
}
