import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { GlslTransitionType } from '../editor/types';
import { ensureSampleFrame } from '../gl/sampleFrames';
import { GLSL_TRANSITIONS } from '../gl/transitions';
import {
  customTransitionUniforms,
  getCustomTransition,
  type CustomTransitionDef,
} from '../gl/customTransitions';
import {
  acquireTransitionThumbRuntime,
  cleanupTransitionThumbResources,
  customTransitionThumbUrl,
  disposeIdleTransitionThumbRuntime,
  drawCustomTransitionFrame,
  drawTransitionFrame,
  getCachedCustomTransitionThumbUrl,
  getCachedTransitionThumbUrl,
  HOVER_HOLD_FRACTION,
  HOVER_DURATION_MS,
  releaseTransitionThumbRuntime,
  THUMB_H,
  THUMB_W,
  transitionThumbUrlAsync,
} from '../gl/transitionThumb';
import { useResourcePreviewCleanup } from './ResourceBrowser';
import { schedulePreviewStill } from './thumbStillQueue';

interface TransitionThumbProps {
  /** Built-in GLSL type id, or plugin:/custom: registry id */
  type: string;
  playing?: boolean;
}

function isBuiltin(type: string): type is GlslTransitionType {
  return type in GLSL_TRANSITIONS;
}

function useTransitionStill(
  type: string,
  custom: CustomTransitionDef | undefined,
  playing: boolean,
): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const cached = isBuiltin(type)
      ? getCachedTransitionThumbUrl(type)
      : custom
        ? getCachedCustomTransitionThumbUrl(custom.id, custom.frag)
        : '';
    setUrl(cached);
    if (cached) return;
    let cancelled = false;
    const load = async () => {
      if (isBuiltin(type)) return transitionThumbUrlAsync(type);
      if (!custom) return '';
      const uniforms = customTransitionUniforms(custom);
      const customCached = getCachedCustomTransitionThumbUrl(custom.id, custom.frag);
      if (customCached) return customCached;
      try {
        await Promise.all([ensureSampleFrame('out'), ensureSampleFrame('in')]);
        if (cancelled) return '';
        return customTransitionThumbUrl(custom.id, custom.frag, uniforms);
      } finally {
        disposeIdleTransitionThumbRuntime();
      }
    };
    const onReady = (resolved: string) => {
      if (!cancelled) setUrl(resolved);
    };
    if (!playing) {
      const cancelScheduled = schedulePreviewStill(load, onReady);
      return () => {
        cancelled = true;
        cancelScheduled();
      };
    }
    void load().then(onReady).catch(() => onReady(''));
    return () => { cancelled = true; };
  }, [custom, playing, type]);
  return url;
}

function transitionProgress(elapsed: number): number {
  const cycle = (elapsed % HOVER_DURATION_MS) / HOVER_DURATION_MS;
  if (cycle < HOVER_HOLD_FRACTION) return 0;
  if (cycle > 1 - HOVER_HOLD_FRACTION) return 1;
  return (cycle - HOVER_HOLD_FRACTION) / (1 - 2 * HOVER_HOLD_FRACTION);
}

function useTransitionAnimation(
  paint: (progress: number) => boolean,
  enabled: boolean,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!enabled || !canvasRef.current) return;
    let raf = 0;
    let held = true;
    let firstFrame = true;
    const startedAt = performance.now();
    const release = () => {
      if (!held) return;
      held = false;
      releaseTransitionThumbRuntime();
    };
    acquireTransitionThumbRuntime();
    const tick = (now: number) => {
      if (!paint(transitionProgress(now - startedAt))) {
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
  }, [canvasRef, enabled, paint]);
  return enabled && ready;
}

export function TransitionThumb({ type, playing = false }: TransitionThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const custom = !isBuiltin(type) ? getCustomTransition(type) : undefined;
  useResourcePreviewCleanup(cleanupTransitionThumbResources);
  const staticUrl = useTransitionStill(type, custom, playing);
  const paint = useCallback((progress: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    if (custom) {
      return drawCustomTransitionFrame(canvas, custom.frag, progress, customTransitionUniforms(custom));
    }
    return isBuiltin(type) && drawTransitionFrame(canvas, type, progress);
  }, [custom, type]);
  const liveReady = useTransitionAnimation(paint, playing && !!staticUrl, canvasRef);

  if (!isBuiltin(type) && !custom) return <span className="cc-resource-thumb-placeholder" />;

  return (
    <div className={`cc-live-thumb${liveReady ? ' is-playing' : ''}`}>
      {staticUrl
        ? <img className="cc-live-thumb-still" src={staticUrl} alt="" draggable={false} loading="lazy" decoding="async" />
        : <span className="cc-resource-thumb-placeholder" />}
      {playing ? (
        <canvas
          ref={canvasRef}
          className="cc-live-thumb-canvas"
          width={THUMB_W}
          height={THUMB_H}
          aria-hidden
        />
      ) : null}
    </div>
  );
}
