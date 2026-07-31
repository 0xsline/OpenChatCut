import type { TimelineItem } from '../../editor/types';
import { sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import { filmstripBackground, peaksPath, useClipPreview } from '../../media/clipPreview';
import { intersectFrameRange, type TimelineFrameWindow } from './timelineUtil';

// Media preview layer within the clip: The video track displays thumbnail frame bars and the sound waves of the clip's own audio track.
// Data comes from /api/waveform, /api/filmstrip (see src/media/clipPreview.ts); geometry button
// srcIn/playbackRate/px mapping, so the frames and waves are in the right position after cropping, speed changing, and timeline scaling.
// The layer is under the label (z-index 0), the pointer is not blocked, and the drag/cropping feel remains unchanged.

const STRIP_RATIO = 0.62; // Video with sound: upper 62% frame bar, lower 38% sound wave

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
  const offsetFrames = intersection.startFrame - options.clipStartFrame;
  return {
    leftPx: offsetFrames * options.px,
    widthPx: Math.max(1, (intersection.endFrame - intersection.startFrame) * options.px),
    durationInFrames: intersection.endFrame - intersection.startFrame,
    srcInFrame: sourceWindowForTimelineRange(
      options,
      offsetFrames,
      intersection.endFrame - intersection.startFrame,
    ).startFrame,
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
  /** The height of the fragment content area (px), the amplitude of the sound wave path is calculated based on it */
  height: number;
  fps: number;
  clipStartFrame: number;
  durationInFrames: number;
  srcInFrame: number;
  playbackRate: number;
  visibleWindow: TimelineFrameWindow;
}) {
  const preview = useClipPreview(item.src, item.kind, item.sourceRevision);
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
