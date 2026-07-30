import type { TimelineItem } from '../../editor/types';
import { filmstripBackground, peaksPath, useClipPreview } from '../../media/clipPreview';
import { intersectFrameRange, type TimelineFrameWindow } from './timelineUtil';

// 片段内的媒体预览层:视频轨显示缩略帧条与片段自身音轨的音波。
// 数据来自 /api/waveform、/api/filmstrip(见 src/media/clipPreview.ts);几何按
// srcIn/playbackRate/px 映射,所以裁剪、变速、时间线缩放后帧与波都对得上位置。
// 层在标签之下(z-index 0),不拦指针,拖拽/裁剪手感不变。

const STRIP_RATIO = 0.62; // 有声视频:上 62% 帧条,下 38% 音波

export interface ClipMediaGeometry {
  leftPx: number;
  widthPx: number;
  durationInFrames: number;
  srcInFrame: number;
}

export function clipMediaGeometry(options: {
  clipStartFrame: number;
  durationInFrames: number;
  srcInFrame: number;
  playbackRate: number;
  px: number;
  visibleWindow: TimelineFrameWindow;
}): ClipMediaGeometry | null {
  const intersection = intersectFrameRange(
    options.clipStartFrame,
    options.durationInFrames,
    options.visibleWindow,
  );
  if (!intersection) return null;
  const playbackRate = options.playbackRate > 0 ? options.playbackRate : 1;
  const offsetFrames = intersection.startFrame - options.clipStartFrame;
  return {
    leftPx: offsetFrames * options.px,
    widthPx: Math.max(1, (intersection.endFrame - intersection.startFrame) * options.px),
    durationInFrames: intersection.endFrame - intersection.startFrame,
    srcInFrame: options.srcInFrame + offsetFrames * playbackRate,
  };
}

interface FilmstripStyle {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPositionX: string;
}

function FilmstripLayer({ geometry, hasWave, strip }: {
  geometry: ClipMediaGeometry;
  hasWave: boolean;
  strip: FilmstripStyle;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute', left: geometry.leftPx, width: geometry.widthPx, top: 0,
        height: hasWave ? `${STRIP_RATIO * 100}%` : '100%',
        zIndex: 0, pointerEvents: 'none', overflow: 'hidden', opacity: 0.92,
        backgroundRepeat: 'no-repeat',
        ...strip,
      }}
    />
  );
}

function WaveLayer({ geometry, height, path, strip, video }: {
  geometry: ClipMediaGeometry;
  height: number;
  path: string;
  strip: boolean;
  video: boolean;
}) {
  return (
    <svg
      aria-hidden
      className={`cc-clip-wave${video ? ' on-video' : ''}`}
      viewBox={`0 0 ${geometry.widthPx.toFixed(1)} ${height.toFixed(1)}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute', left: geometry.leftPx, width: geometry.widthPx, bottom: 0,
        height: strip ? `${(1 - STRIP_RATIO) * 100}%` : '100%',
        zIndex: 0, pointerEvents: 'none', overflow: 'hidden',
      }}
    >
      <path d={path} />
    </svg>
  );
}

export function ClipMediaLayers({ item, px, fps, height, clipStartFrame, durationInFrames,
  srcInFrame, playbackRate, visibleWindow }: {
  item: TimelineItem;
  px: number;
  /** 片段内容区高度(px),音波路径按它算振幅 */
  height: number;
  fps: number;
  clipStartFrame: number;
  durationInFrames: number;
  srcInFrame: number;
  playbackRate: number;
  visibleWindow: TimelineFrameWindow;
}) {
  const preview = useClipPreview(item.src, item.kind);
  const geometry = clipMediaGeometry({
    clipStartFrame, durationInFrames, srcInFrame, playbackRate, px, visibleWindow,
  });
  if (!preview || !geometry || height <= 0) return null;

  const isVideo = item.kind === 'video';
  const strip = isVideo ? filmstripBackground(preview, {
    px, fps, srcInFrame: geometry.srcInFrame, playbackRate,
  }) : null;
  const hasWave = preview.peaks.length > 0;
  const waveH = strip && hasWave ? Math.max(6, height * (1 - STRIP_RATIO)) : height;
  const d = hasWave
    ? peaksPath(preview, {
        widthPx: geometry.widthPx, height: waveH, fps,
        srcInFrame: geometry.srcInFrame, durationInFrames: geometry.durationInFrames, playbackRate,
      })
    : '';

  return (
    <>
      {strip && <FilmstripLayer geometry={geometry} hasWave={hasWave} strip={strip} />}
      {d && <WaveLayer geometry={geometry} height={waveH} path={d} strip={!!strip} video={isVideo} />}
    </>
  );
}
