import { useEffect, useMemo, useRef } from 'react';
import { AbsoluteFill, Img, Video, continueRender, delayRender } from 'remotion';
import { createGlRuntime, type GlRuntime } from './runtime';
import { FX_EFFECTS, fxUniforms } from './fx/effects';
import type { AspectFit, TimelineItem } from '../editor/types';

// One video/image clip rendered through a per-clip WebGL effect (source
// builtin:fx-* single-input renderPass). Mounts a hidden, frame-synced media
// element (Remotion keeps it accurate in preview AND headless render),
// rasterizes it to a 2D staging canvas with the clip's contain/cover layout,
// then runs the effect's fragment shader to the visible canvas (with alpha, so
// luma-key etc. composite over lower tracks). v1 applies the FIRST registered
// effect in the stack; multi-effect chaining is a follow-up.

interface ClipFxProps {
  item: TimelineItem;
  fit: AspectFit;
  width: number;
  height: number;
}

type MediaEl = HTMLVideoElement | HTMLImageElement;

const isReady = (el: MediaEl): boolean =>
  el instanceof HTMLVideoElement ? el.readyState >= 2 && !el.seeking : el.complete;

// contain/cover placement matching MediaFill's objectFit, so GL frames align
// with the rest of the composition.
function drawFit(ctx: CanvasRenderingContext2D, el: MediaEl, fit: AspectFit): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const nw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const nh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  ctx.clearRect(0, 0, W, H);
  if (!nw || !nh) return;
  const scale = fit === 'cover' ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  ctx.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/** the first stack entry whose assetId is a registered GL effect */
export function firstGlEffect(item: TimelineItem) {
  const e = item.effects?.find((fx) => fx.assetId in FX_EFFECTS);
  return e ? { fx: e, def: FX_EFFECTS[e.assetId] } : null;
}

export function ClipFx({ item, fit, width, height }: ClipFxProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const elRef = useRef<MediaEl | null>(null);

  const staging = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }, [width, height]);

  const active = firstGlEffect(item);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const handle = delayRender(`clip-fx ${active.def.id}`);
    let done = false;
    let raf = 0;
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    const tick = () => {
      const el = elRef.current;
      if (!el || !isReady(el)) { raf = requestAnimationFrame(tick); return; }
      try {
        if (!runtimeRef.current) runtimeRef.current = createGlRuntime(canvas);
        const ctx = staging.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        drawFit(ctx, el, fit);
        runtimeRef.current.renderFx(active.def.frag, staging, fxUniforms(active.def, active.fx.overrides));
      } catch (e) {
        // WebGL unavailable / compile failure → leave canvas empty; the source
        // clip still shows nothing worse than a transparent frame.
        // ponytail: no GL re-probe; a broken stack degrades to a blank layer.
        console.error('[clip-fx]', e);
      }
      finish();
    };
    tick();
    return () => { cancelAnimationFrame(raf); finish(); };
    // re-run whenever the effect params change; item identity covers overrides.
  }, [active, fit, staging, item]);

  useEffect(() => () => { runtimeRef.current?.dispose(); runtimeRef.current = null; }, []);

  if (!active) return null;
  return (
    <AbsoluteFill>
      {/* hidden frame-synced source (opacity keeps decode/seek active; muted —
          the composition's own clip owns audio) */}
      <AbsoluteFill style={{ opacity: 0, pointerEvents: 'none' }}>
        {item.kind === 'image'
          ? <Img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={item.src!} />
          : <Video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} src={item.src!} trimBefore={item.srcInFrame ?? 0} muted />}
      </AbsoluteFill>
      <canvas ref={canvasRef} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </AbsoluteFill>
  );
}
