import { useCallback, useEffect, useRef } from 'react';
import type { SlipPreview } from '../editor/slip';
import { useT } from '../i18n/locale';

interface SourceFrameProps {
  src: string;
  frame: number;
  fps: number;
  label: string;
  audio: boolean;
}

function SourceFrame({ src, frame, fps, label, audio }: SourceFrameProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const seek = useCallback(() => {
    const media = ref.current;
    if (!media || media.readyState === 0) return;
    const targetSeconds = Math.max(0, frame) / Math.max(1, fps);
    const maxSeconds = Number.isFinite(media.duration)
      ? Math.max(0, media.duration - 1 / Math.max(1, fps))
      : targetSeconds;
    media.currentTime = Math.min(targetSeconds, maxSeconds);
  }, [fps, frame]);

  useEffect(seek, [seek]);

  return (
    <figure className="cc-slip-two-up-frame">
      <div className="cc-slip-two-up-media">
        {!audio && (
          <video
            ref={ref}
            src={src}
            muted
            playsInline
            preload="auto"
            aria-label={label}
            onLoadedMetadata={seek}
          />
        )}
        {audio && <span className="cc-slip-two-up-audio" aria-hidden="true">⌁⌁⌁</span>}
      </div>
      <figcaption>
        <span>{label}</span>
        <b>{frame.toFixed(Number.isInteger(frame) ? 0 : 2)}f</b>
        <small>{(frame / Math.max(1, fps)).toFixed(2)}s</small>
      </figcaption>
    </figure>
  );
}

export function SlipTwoUpPreview({ preview }: { preview: SlipPreview }) {
  const t = useT();
  const { plan } = preview;
  return (
    <aside className="cc-slip-two-up" role="status" aria-live="off" aria-label={t('滑移预览')}>
      <div className="cc-slip-two-up-head">
        <strong>{t('滑移')}</strong>
        <span title={preview.itemName}>{preview.itemName}</span>
        <b>{plan.appliedDeltaInFrames >= 0 ? '+' : ''}{plan.appliedDeltaInFrames.toFixed(2)}f</b>
      </div>
      <div className="cc-slip-two-up-grid">
        <SourceFrame
          src={preview.src}
          frame={preview.sourceInFrame}
          fps={preview.fps}
          label={t('源入点')}
          audio={preview.kind === 'audio'}
        />
        <SourceFrame
          src={preview.src}
          frame={preview.sourceOutFrame}
          fps={preview.fps}
          label={t('源出点')}
          audio={preview.kind === 'audio'}
        />
      </div>
      {plan.clamped && <div className="cc-slip-two-up-limit">{t('已到达源素材边界')}</div>}
    </aside>
  );
}
