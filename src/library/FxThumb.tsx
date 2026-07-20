import { useEffect, useRef, useState } from 'react';
import { ALL_FX } from '../gl/fx/effects';
import {
  drawFxFrame,
  FX_HOVER_MS,
  FX_THUMB_H,
  FX_THUMB_W,
  fxHoverOverrides,
  fxThumbUrl,
  fxThumbUrlAsync,
} from '../gl/fxThumb';
import { ensureSampleFrame } from '../gl/sampleFrames';

interface FxThumbProps {
  assetId: string;
  playing?: boolean;
}

export function FxThumb({ assetId, playing = false }: FxThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [localHover, setLocalHover] = useState(false);
  const [staticUrl, setStaticUrl] = useState('');
  const active = playing || localHover;
  const def = ALL_FX[assetId];

  // load photoreal sample then bake still
  useEffect(() => {
    if (!def) return;
    let cancelled = false;
    (async () => {
      await ensureSampleFrame('fx');
      if (cancelled) return;
      const url = await fxThumbUrlAsync(def);
      if (!cancelled) setStaticUrl(url || fxThumbUrl(def));
      const c = canvasRef.current;
      if (c && !cancelled) drawFxFrame(c, def, 0.5);
    })();
    return () => { cancelled = true; };
  }, [def]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !def) return;
    if (!active) {
      drawFxFrame(c, def, 0.5);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const phase = ((now - t0) % FX_HOVER_MS) / FX_HOVER_MS;
      // faster wall time for CRT/shake/ascii; phase drives property pulses
      const time = phase * 4.5;
      const overrides = fxHoverOverrides(def, phase);
      drawFxFrame(c, def, time, overrides);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, def]);

  if (!def) return <span className="cc-resource-thumb-placeholder" />;

  return (
    <div
      className={`cc-live-thumb${active ? ' is-playing' : ''}`}
      onPointerEnter={() => setLocalHover(true)}
      onPointerLeave={() => setLocalHover(false)}
    >
      {staticUrl ? <img className="cc-live-thumb-still" src={staticUrl} alt="" draggable={false} /> : null}
      <canvas
        ref={canvasRef}
        className="cc-live-thumb-canvas"
        width={FX_THUMB_W}
        height={FX_THUMB_H}
        aria-hidden
      />
    </div>
  );
}
