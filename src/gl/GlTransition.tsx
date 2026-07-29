import { useEffect, useMemo, useRef } from 'react';
import { AbsoluteFill, Img, Video, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { createGlRuntime, type GlRuntime } from './runtime';
import { GLSL_TRANSITIONS } from './transitions';
import type { AspectFit, GlslTransitionType, TimelineItem, TransitionDirection } from '../editor/types';

// One GLSL transition window straddling the cut from R to R+L. Mounts
// its own hidden, muted media elements for both clips (Remotion keeps them
// frame-accurate in preview AND in headless render), rasterizes each to a 2D
// staging canvas with the clip's contain/cover placement, and mixes the two
// canvases in WebGL with the transition's fragment shader, following the
// compositor's texture path (decoded frame / canvas → texImage2D); DOM clips
// (MG/text) can't be textured — the composition falls back to CSS for those,
// so MG layers stay outside the GL pipeline.

interface GlTransitionProps {
  type: GlslTransitionType | 'custom-shader';
  direction: TransitionDirection;
  /** type='custom-shader': the submit_shader-generated two-input GLSL (from the item) + its
   *  uniform values. When present, rendered instead of a GLSL_TRANSITIONS built-in. */
  customFrag?: string;
  customUniforms?: Record<string, number>;
  /** transition length in frames */
  L: number;
  /** absolute timeline frame where the window starts (for u_time) */
  windowStart: number;
  outgoing: TimelineItem;
  incoming: TimelineItem;
  /** source in-points (frames) for each clip at the window start */
  trimOut: number;
  trimIn: number;
  width: number;
  height: number;
  fit: AspectFit;
}

type MediaEl = HTMLVideoElement | HTMLImageElement;

const isReady = (el: MediaEl): boolean =>
  el instanceof HTMLVideoElement ? el.readyState >= 2 && !el.seeking : el.complete;

// draw a media element into the staging canvas with contain/cover placement
// (same math as MediaFill's objectFit, so GL frames match the DOM rendering).
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

function MediaSource({ item, trim, elRef }: { item: TimelineItem; trim: number; elRef: React.MutableRefObject<MediaEl | null> }) {
  if (item.kind === 'image') {
    // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
    return <Img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={item.src!} />;
  }
  // muted: the ORIGINAL clip sequences (rendered beneath the GL canvas) own the audio
  return <Video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} src={item.src!} trimBefore={trim} muted />;
}

export function GlTransition({ type, direction, L, windowStart, outgoing, incoming, trimOut, trimIn, width, height, fit, customFrag, customUniforms }: GlTransitionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const outRef = useRef<MediaEl | null>(null);
  const inRef = useRef<MediaEl | null>(null);

  // 2D staging canvases: clip pixels with contain/cover layout → GL texture source
  const staging = useMemo(() => {
    const make = () => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      return c;
    };
    return { out: make(), in: make() };
  }, [width, height]);

  // custom-shader: build the def from the item's stored GLSL; built-ins come from the registry.
  // Memoized so the def keeps a stable identity across the per-frame renders below.
  const def = useMemo(
    () => (type === 'custom-shader'
      ? (customFrag ? { frag: customFrag, uniforms: () => customUniforms ?? {} } : undefined)
      : GLSL_TRANSITIONS[type]),
    [type, customFrag, customUniforms],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !def) return;
    const handle = delayRender(`gl-transition ${type} f${frame}`);
    let done = false;
    let raf = 0;
    const finish = () => {
      if (!done) {
        done = true;
        continueRender(handle);
      }
    };
    const tick = () => {
      const o = outRef.current;
      const i = inRef.current;
      if (!o || !i || !isReady(o) || !isReady(i)) {
        raf = requestAnimationFrame(tick);
        return;
      }
      try {
        if (!runtimeRef.current) runtimeRef.current = createGlRuntime(canvas);
        const octx = staging.out.getContext('2d')!;
        const ictx = staging.in.getContext('2d')!;
        drawFit(octx, o, fit);
        drawFit(ictx, i, fit);
        const progress = L > 0 ? frame / L : 1;
        const time = (windowStart + frame) / fps;
        runtimeRef.current.render(def.frag, staging.out, staging.in, progress, def.uniforms({ time, aspect: width / Math.max(1, height), direction }));
      } catch (e) {
        // WebGL unavailable / compile failure: leave the canvas empty — the
        // underlying clips still render beneath (hard cut instead of transition).
        // ponytail: no runtime re-probe; a broken GL stack degrades to a cut.
        console.error('[gl-transition]', e);
      }
      finish();
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      finish();
    };
  }, [frame, fps, L, windowStart, fit, type, direction, def, staging, width, height]);

  useEffect(() => () => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
  }, []);

  return (
    <AbsoluteFill>
      {/* hidden frame-synced media sources (opacity keeps decode/seek active) */}
      <AbsoluteFill style={{ opacity: 0, pointerEvents: 'none' }}>
        <MediaSource item={outgoing} trim={trimOut} elRef={outRef} />
        <MediaSource item={incoming} trim={trimIn} elRef={inRef} />
      </AbsoluteFill>
      <canvas ref={canvasRef} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </AbsoluteFill>
  );
}
