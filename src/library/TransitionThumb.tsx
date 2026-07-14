import { useEffect, useRef, useState } from 'react';
import type { GlslTransitionType } from '../editor/types';
import { ensureSampleFrame } from '../gl/sampleFrames';
import {
  drawTransitionFrame,
  HOVER_DURATION_MS,
  THUMB_H,
  THUMB_W,
  transitionThumbUrl,
  transitionThumbUrlAsync,
} from '../gl/transitionThumb';

interface TransitionThumbProps {
  type: GlslTransitionType;
  playing?: boolean;
}

export function TransitionThumb({ type, playing = false }: TransitionThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [localHover, setLocalHover] = useState(false);
  const [staticUrl, setStaticUrl] = useState('');
  const active = playing || localHover;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([ensureSampleFrame('out'), ensureSampleFrame('in')]);
      if (cancelled) return;
      const url = await transitionThumbUrlAsync(type);
      if (!cancelled) setStaticUrl(url || transitionThumbUrl(type));
      const c = canvasRef.current;
      if (c && !cancelled) drawTransitionFrame(c, type, 0.42);
    })();
    return () => { cancelled = true; };
  }, [type]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (!active) {
      drawTransitionFrame(c, type, 0.42);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    // full 0→1, brief hold at ends so the swap is obvious
    const HOLD = 0.1;
    const tick = (now: number) => {
      const cycle = ((now - t0) % HOVER_DURATION_MS) / HOVER_DURATION_MS;
      let progress: number;
      if (cycle < HOLD) progress = 0;
      else if (cycle > 1 - HOLD) progress = 1;
      else progress = (cycle - HOLD) / (1 - 2 * HOLD);
      drawTransitionFrame(c, type, progress);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, type]);

  return (
    <div
      className={`cc-live-thumb${active ? ' is-playing' : ''}`}
      onPointerEnter={() => setLocalHover(true)}
      onPointerLeave={() => setLocalHover(false)}
    >
      {staticUrl ? (
        <img className="cc-live-thumb-still" src={staticUrl} alt="" draggable={false} />
      ) : null}
      {/* always-on when still missing so cards never look empty after a GL miss */}
      <canvas
        ref={canvasRef}
        className={`cc-live-thumb-canvas${staticUrl ? '' : ' always-on'}`}
        width={THUMB_W}
        height={THUMB_H}
        aria-hidden
      />
    </div>
  );
}
