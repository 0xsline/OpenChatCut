import { useEffect, useMemo, useRef } from 'react';
import { AbsoluteFill, Img, Video, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { createGlRuntime, type GlRuntime } from './runtime';
import { cubeSettled, ensureCube } from './fx/cube';
import { fxPasses } from './fx/uniforms';
import type { AspectFit, TimelineItem } from '../editor/types';
import { glEffects } from './clipEffects';

// One video/image clip rendered through a builtin:fx-* single-input WebGL pass.
// Mounts a hidden, frame-synced media
// element (Remotion keeps it accurate in preview AND headless render),
// rasterizes it to a 2D staging canvas with the clip's contain/cover layout,
// then runs the effect's fragment shader to the visible canvas (with alpha, so
// luma-key etc. composite over lower tracks). Registered effects are flattened
// into one ordered pass graph, preserving the clip's effects[] order.

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

export function ClipFx({ item, fit, width, height }: ClipFxProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const elRef = useRef<MediaEl | null>(null);

  const staging = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }, [width, height]);

  const active = glEffects(item);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || active.length === 0) return;
    const handle = delayRender(`clip-fx ${active.map(({ def }) => def.id).join(',')}`);
    let done = false;
    let raf = 0;
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    // .cube LUT Load first;tick Wait until there is a conclusion(success→Color registration,failed→pass-through)Just painted the first frame,
    // Headless export delayRender So the frame is stuck to LUT ready,No early, ungraded frames are burned in.
    for (const { def } of active) if (def.cube) void ensureCube(def.cube);
    const tick = () => {
      const el = elRef.current;
      if (!el || !isReady(el)) { raf = requestAnimationFrame(tick); return; }
      if (active.some(({ def }) => def.cube && !cubeSettled(def.cube))) { raf = requestAnimationFrame(tick); return; }
      try {
        if (!runtimeRef.current) runtimeRef.current = createGlRuntime(canvas);
        const ctx = staging.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        drawFit(ctx, el, fit);
        // u_time (seconds, clip-local) drives animated fx (CRT wobble/noise,
        // camera shake); static fx ignore it.
        runtimeRef.current.renderFxChain(
          fxPasses(active.map(({ fx, def }) => ({ def, overrides: fx.overrides })), frame / fps),
          staging,
        );
      } catch (e) {
        // WebGL unavailable / compile failure → leave canvas empty; the media
        // clip still shows nothing worse than a transparent frame.
        // ponytail: no GL re-probe; a broken stack degrades to a blank layer.
        console.error('[clip-fx]', e);
      }
      finish();
    };
    tick();
    return () => { cancelAnimationFrame(raf); finish(); };
    // re-run each frame (animated fx need u_time) + when params/layout change.
  }, [active, fit, staging, item, frame, fps]);

  useEffect(() => () => { runtimeRef.current?.dispose(); runtimeRef.current = null; }, []);

  if (active.length === 0) return null;
  return (
    <AbsoluteFill>
      {/* hidden frame-synced source (opacity keeps decode/seek active; muted —
          the composition's own clip owns audio) */}
      <AbsoluteFill style={{ opacity: 0, pointerEvents: 'none' }}>
        {item.kind === 'image'
          // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
          ? <Img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={item.src!} />
          : <Video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} src={item.src!} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1} muted />}
      </AbsoluteFill>
      <canvas ref={canvasRef} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </AbsoluteFill>
  );
}
