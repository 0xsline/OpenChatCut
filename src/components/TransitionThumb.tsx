import { useEffect, useMemo, useRef, useState } from 'react';
import type { GlslTransitionType } from '../editor/types';
import {
  drawTransitionFrame,
  HOVER_DURATION_MS,
  THUMB_H,
  THUMB_W,
  transitionThumbUrl,
} from '../gl/transitionThumb';

// Source library cards: resting mid-frame still → on hover, loop the full
// GLSL transition 0→1 (shared WebGL runtime via transitionThumb).
// Hover is driven by parent `playing` OR local pointer events (belt + suspenders).

interface TransitionThumbProps {
  type: GlslTransitionType;
  /** parent card is hovered — play the animated preview */
  playing?: boolean;
}

export function TransitionThumb({ type, playing = false }: TransitionThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [localHover, setLocalHover] = useState(false);
  const active = playing || localHover;
  const staticUrl = useMemo(() => transitionThumbUrl(type), [type]);

  // paint mid-frame once so the canvas isn't blank before first hover
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    drawTransitionFrame(c, type, 0.48);
  }, [type]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (!active) {
      drawTransitionFrame(c, type, 0.48);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    // 0→1 linear, brief hold at end, then loop — matches source library previews
    const HOLD = 0.12;
    const tick = (now: number) => {
      const cycle = ((now - t0) % HOVER_DURATION_MS) / HOVER_DURATION_MS;
      const progress = cycle < 1 - HOLD ? cycle / (1 - HOLD) : 1;
      drawTransitionFrame(c, type, progress);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, type]);

  return (
    <div
      className={`cc-transition-thumb${active ? ' is-playing' : ''}`}
      onPointerEnter={() => setLocalHover(true)}
      onPointerLeave={() => setLocalHover(false)}
    >
      {staticUrl ? (
        <img className="cc-transition-thumb-still" src={staticUrl} alt="" draggable={false} />
      ) : null}
      <canvas
        ref={canvasRef}
        className="cc-transition-thumb-canvas"
        width={THUMB_W}
        height={THUMB_H}
        aria-hidden
      />
    </div>
  );
}
