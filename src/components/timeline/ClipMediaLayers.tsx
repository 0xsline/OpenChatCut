import type { TimelineItem } from '../../editor/types';
import { filmstripBackground, peaksPath, useClipPreview } from '../../media/clipPreview';

// Media preview layer within the clip: The video track displays thumbnail frame bars and the sound waves of the clip's own audio track.
// Data comes from /api/waveform, /api/filmstrip (see src/media/clipPreview.ts); geometry button
// srcIn/playbackRate/px mapping, so the frames and waves are in the right position after cropping, speed changing, and timeline scaling.
// The layer is under the label (z-index 0), the pointer is not blocked, and the drag/cropping feel remains unchanged.

const STRIP_RATIO = 0.62; // Video with sound: upper 62% frame bar, lower 38% sound wave

export function ClipMediaLayers({ item, px, fps, height }: {
  item: TimelineItem;
  px: number;
  /** The height of the fragment content area (px), the amplitude of the sound wave path is calculated based on it */
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
