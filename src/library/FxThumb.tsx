import { useEffect, useRef, useState, type RefObject } from 'react';
import { ALL_FX, type FxDef } from '../gl/fx/effects';
import {
  acquireFxThumbRuntime,
  cleanupFxThumbResources,
  drawFxFrame,
  FX_HOVER_MS,
  FX_THUMB_H,
  FX_THUMB_W,
  getCachedFxThumbUrl,
  fxHoverOverrides,
  fxThumbUrlAsync,
  releaseFxThumbRuntime,
} from '../gl/fxThumb';
import { useResourcePreviewCleanup } from './ResourcePreviewContext';
import { schedulePreviewStill } from './thumbStillQueue';

interface FxThumbProps {
  assetId: string;
  playing?: boolean;
}

function useFxStill(def: FxDef | undefined, playing: boolean): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!def) {
      setUrl('');
      return;
    }
    const cached = getCachedFxThumbUrl(def.id);
    setUrl(cached);
    if (cached) return;
    let cancelled = false;
    const onReady = (resolved: string) => {
      if (!cancelled) setUrl(resolved);
    };
    if (!playing) {
      const cancelScheduled = schedulePreviewStill(() => fxThumbUrlAsync(def), onReady);
      return () => {
        cancelled = true;
        cancelScheduled();
      };
    }
    void fxThumbUrlAsync(def).then(onReady).catch(() => onReady(''));
    return () => { cancelled = true; };
  }, [def, playing]);
  return url;
}

function useFxAnimation(
  def: FxDef | undefined,
  enabled: boolean,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const canvas = canvasRef.current;
    if (!enabled || !canvas || !def) return;
    let raf = 0;
    let held = true;
    let firstFrame = true;
    const startedAt = performance.now();
    const release = () => {
      if (!held) return;
      held = false;
      releaseFxThumbRuntime();
    };
    acquireFxThumbRuntime();
    const tick = (now: number) => {
      const phase = ((now - startedAt) % FX_HOVER_MS) / FX_HOVER_MS;
      const drawn = drawFxFrame(canvas, def, phase * 4.5, fxHoverOverrides(def, phase));
      if (!drawn) {
        setReady(false);
        release();
        return;
      }
      if (firstFrame) {
        firstFrame = false;
        setReady(true);
      }
      raf = requestAnimationFrame(tick);
    };
    tick(startedAt);
    return () => {
      cancelAnimationFrame(raf);
      release();
    };
  }, [canvasRef, def, enabled]);
  return enabled && ready;
}

export function FxThumb({ assetId, playing = false }: FxThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const def = ALL_FX[assetId];
  useResourcePreviewCleanup(cleanupFxThumbResources);
  const staticUrl = useFxStill(def, playing);
  const liveReady = useFxAnimation(def, playing && !!staticUrl, canvasRef);

  if (!def) return <span className="cc-resource-thumb-placeholder" />;

  return (
    <div className={`cc-live-thumb${liveReady ? ' is-playing' : ''}`}>
      {staticUrl
        ? <img className="cc-live-thumb-still" src={staticUrl} alt="" draggable={false} loading="lazy" decoding="async" />
        : <span className="cc-resource-thumb-placeholder" />}
      {playing ? (
        <canvas
          ref={canvasRef}
          className="cc-live-thumb-canvas"
          width={FX_THUMB_W}
          height={FX_THUMB_H}
          aria-hidden
        />
      ) : null}
    </div>
  );
}
