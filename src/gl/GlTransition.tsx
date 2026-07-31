import { useEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Img, Video, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { createGlRuntime, type GlRuntime } from './runtime';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import { buildTransitionShaderFrame } from './shaderFrame';
import { glPreviewFailureReason, glTransitionPresentation } from './previewAdapter';
import type { SelectedPreviewFallbackReason, SelectedPreviewStatusListener } from './previewAdapter';
import { GLSL_TRANSITIONS } from './transitions';
import { PreviewTransitionIn } from '../editor/transitionPreview';
import type { AspectFit, CssTransitionType, GlslTransitionType, TimelineItem, TransitionDirection } from '../editor/types';

// One GLSL transition window straddling the cut from R to R+L. One muted,
// frame-synced media pair feeds both the deterministic CSS fallback and the 2D
// staging canvases. The fallback is authoritative while sources/GL are pending
// or failed; the GL canvas replaces it only after the exact frame is drawn.
// DOM clips (MG/text) cannot be textured, so TimelineComposition keeps them on
// its existing CSS path.

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
  fallbackType: CssTransitionType;
  fallbackLine?: boolean;
  previewTargetId?: string;
  onPreviewStatus?: SelectedPreviewStatusListener;
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

function MediaSource({ item, trim, fit, elRef }: { item: TimelineItem; trim: number; fit: AspectFit; elRef: React.MutableRefObject<MediaEl | null> }) {
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: fit };
  if (item.kind === 'image') {
    // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
    return <Img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={item.src!} style={style} />;
  }
  // muted: the ORIGINAL clip sequences own audio; this element owns fallback + GL pixels.
  return <Video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} src={item.src!} trimBefore={trim} playbackRate={item.playbackRate ?? 1} muted style={style} />;
}

export function GlTransition({ type, direction, L, windowStart, outgoing, incoming, trimOut, trimIn, width, height, fit, fallbackType, fallbackLine, customFrag, customUniforms, previewTargetId, onPreviewStatus }: GlTransitionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const outRef = useRef<MediaEl | null>(null);
  const inRef = useRef<MediaEl | null>(null);
  const failedAdapterRef = useRef<{ frag: string; reason: SelectedPreviewFallbackReason } | null>(null);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);

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
  const renderKey = useMemo(
    () => JSON.stringify([
      frame, L, windowStart, width, height, fit, type, direction,
      customUniforms, outgoing.src, incoming.src, trimOut, trimIn,
    ]),
    [frame, L, windowStart, width, height, fit, type, direction, customUniforms, outgoing.src, incoming.src, trimOut, trimIn],
  );
  const presentation = glTransitionPresentation(renderedKey === renderKey);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !def) return;
    // delayRender only for headless export — it must wait for both sources
    // before capturing the frame. In the Player, waiting stalls the whole
    // transport, so the explicit waiting/fallback status replaces blocking.
    const blockForExport = getRemotionEnvironment().isRendering;
    const handle = blockForExport ? delayRender(`gl-transition ${type} f${frame}`) : null;
    let done = false;
    let raf = 0;
    const report = (phase: 'waiting' | 'ready' | 'fallback', fallbackReason?: SelectedPreviewFallbackReason) => {
      if (!previewTargetId || !onPreviewStatus) return;
      onPreviewStatus({
        kind: 'transition',
        targetId: previewTargetId,
        adapter: phase === 'ready' ? 'gl-transition' : 'css-transition',
        phase,
        fallbackReason,
      });
    };
    const finish = () => {
      if (!done && handle != null) {
        done = true;
        continueRender(handle);
      }
    };
    const priorFailure = failedAdapterRef.current?.frag === def.frag ? failedAdapterRef.current.reason : null;
    if (priorFailure) {
      canvas.style.opacity = '0';
      if (fallbackRef.current) fallbackRef.current.style.opacity = '1';
      setRenderedKey(null);
      report('fallback', priorFailure);
      finish();
      return () => finish();
    }
    let waitingReported = false;
    const reportWaiting = () => {
      if (waitingReported) return;
      waitingReported = true;
      report('fallback', 'media-loading');
    };
    const tick = () => {
      const o = outRef.current;
      const i = inRef.current;
      if (!o || !i || !isReady(o) || !isReady(i)) {
        reportWaiting();
        raf = requestAnimationFrame(tick);
        return;
      }
      try {
        const runtime = ensureRuntimeSlot(runtimeRef, () => createGlRuntime(canvas));
        const octx = staging.out.getContext('2d');
        const ictx = staging.in.getContext('2d');
        if (!octx || !ictx) throw new Error('2d context unavailable');
        drawFit(octx, o, fit);
        drawFit(ictx, i, fit);
        const shaderFrame = buildTransitionShaderFrame(def, {
          sequenceFrame: frame,
          durationInFrames: L,
          windowStartFrame: windowStart,
          fps,
          width,
          height,
          direction,
        });
        runtime.render(shaderFrame.frag, staging.out, staging.in, shaderFrame.progress, shaderFrame.uniforms);
        canvas.style.opacity = '1';
        if (fallbackRef.current) fallbackRef.current.style.opacity = '0';
        setRenderedKey(renderKey);
        report('ready');
      } catch (error) {
        const reason = glPreviewFailureReason(error);
        failedAdapterRef.current = { frag: def.frag, reason };
        disposeRuntimeSlot(runtimeRef);
        canvas.style.opacity = '0';
        if (fallbackRef.current) fallbackRef.current.style.opacity = '1';
        setRenderedKey(null);
        report('fallback', reason);
        console.error('[gl-transition]', error);
      }
      finish();
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      finish();
    };
  }, [frame, fps, L, windowStart, fit, type, direction, def, staging, width, height, renderKey, previewTargetId, onPreviewStatus]);

  useEffect(() => () => {
    disposeRuntimeSlot(runtimeRef);
  }, [width, height, def?.frag]);

  return (
    <AbsoluteFill>
      <AbsoluteFill ref={fallbackRef} style={{ opacity: presentation.showFallback ? 1 : 0, pointerEvents: 'none' }}>
        <MediaSource item={outgoing} trim={trimOut} fit={fit} elRef={outRef} />
        <PreviewTransitionIn type={fallbackType} frames={L} dir={direction} line={fallbackLine}>
          <MediaSource item={incoming} trim={trimIn} fit={fit} elRef={inRef} />
        </PreviewTransitionIn>
      </AbsoluteFill>
      <canvas ref={canvasRef} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: presentation.showGl ? 1 : 0 }} />
    </AbsoluteFill>
  );
}
