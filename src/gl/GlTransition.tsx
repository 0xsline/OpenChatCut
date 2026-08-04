import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Img, Video, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { createGlRuntime, type GlRuntime } from './runtime';
import { cubeSettled, ensureCube } from './fx/cube';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import { buildEffectShaderFrame, buildTransitionShaderFrame } from './shaderFrame';
import { glPreviewFailureReason } from './previewAdapter';
import type { SelectedPreviewFallbackReason, SelectedPreviewStatusListener } from './previewAdapter';
import { GLSL_TRANSITIONS } from './transitions';
import { glEffects } from './clipEffects';
import type { AspectFit, GlslTransitionType, TimelineItem, TransitionDirection } from '../editor/types';

// One GLSL transition window straddling the cut from R to R+L. A muted,
// frame-synced media pair feeds 2D staging canvases, each clip's ordered effect
// graph, then the transition shader in one WebGL context. TimelineComposition's
// effect-aware CSS composition remains visible until the exact GL frame is ready.
// DOM clips (MG/text) stay on that CSS path because they cannot be textured.

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
  // Muted: the original clip sequences own audio; this element only feeds GL textures.
  return <Video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} src={item.src!} trimBefore={trim} playbackRate={item.playbackRate ?? 1} muted style={style} />;
}

export function GlTransition({ type, direction, L, windowStart, outgoing, incoming, trimOut, trimIn, width, height, fit, customFrag, customUniforms, previewTargetId, onPreviewStatus }: GlTransitionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const outRef = useRef<MediaEl | null>(null);
  const inRef = useRef<MediaEl | null>(null);
  const failedAdapterRef = useRef<{ definitionKey: string; reason: SelectedPreviewFallbackReason } | null>(null);
  const hasRenderedFrameRef = useRef(false);
  const [hasRenderedFrame, setHasRenderedFrame] = useState(false);

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
  const outgoingEffects = useMemo(() => glEffects(outgoing), [outgoing]);
  const incomingEffects = useMemo(() => glEffects(incoming), [incoming]);
  const definitionKey = useMemo(
    () => [
      def?.frag ?? '',
      ...outgoingEffects.map(({ def: effect }) => effect.frag),
      ...incomingEffects.map(({ def: effect }) => effect.frag),
    ].join('\u0000'),
    [def?.frag, incomingEffects, outgoingEffects],
  );

  useEffect(() => {
    if (!onPreviewStatus || !previewTargetId) return;
    const targetId = previewTargetId;
    return () => {
      onPreviewStatus({
        kind: 'transition',
        targetId,
        adapter: 'gl-transition',
        phase: 'inactive',
      });
    };
  }, [onPreviewStatus, previewTargetId]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !def) return;
    // Headless export waits for both sources and LUTs. Player preview keeps the
    // effect-aware timeline composition visible until an exact GL frame exists.
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
    const hideCanvas = () => {
      canvas.style.opacity = '0';
      if (hasRenderedFrameRef.current) {
        hasRenderedFrameRef.current = false;
        setHasRenderedFrame(false);
      }
    };
    const priorFailure = failedAdapterRef.current?.definitionKey === definitionKey
      ? failedAdapterRef.current.reason
      : null;
    if (priorFailure) {
      hideCanvas();
      report('fallback', priorFailure);
      finish();
      return () => finish();
    }
    const activeEffects = [...outgoingEffects, ...incomingEffects];
    for (const { def: effect } of activeEffects) {
      if (effect.cube) void ensureCube(effect.cube);
    }
    let waitingReported = false;
    const reportWaiting = () => {
      if (waitingReported) return;
      waitingReported = true;
      report('fallback', 'media-loading');
    };
    const tick = () => {
      const outgoingSource = outRef.current;
      const incomingSource = inRef.current;
      if (!outgoingSource || !incomingSource || !isReady(outgoingSource) || !isReady(incomingSource)
        || activeEffects.some(({ def: effect }) => effect.cube && !cubeSettled(effect.cube))) {
        hideCanvas();
        reportWaiting();
        raf = requestAnimationFrame(tick);
        return;
      }
      try {
        const runtime = ensureRuntimeSlot(runtimeRef, () => createGlRuntime(canvas));
        const outgoingContext = staging.out.getContext('2d');
        const incomingContext = staging.in.getContext('2d');
        if (!outgoingContext || !incomingContext) throw new Error('2d context unavailable');
        drawFit(outgoingContext, outgoingSource, fit);
        drawFit(incomingContext, incomingSource, fit);
        const transitionFrame = buildTransitionShaderFrame(def, {
          sequenceFrame: frame,
          durationInFrames: L,
          windowStartFrame: windowStart,
          fps,
          width,
          height,
          direction,
        });
        const absoluteFrame = windowStart + frame;
        const outgoingFrame = buildEffectShaderFrame(
          outgoingEffects.map(({ fx, def: effect }) => ({ def: effect, overrides: fx.overrides })),
          absoluteFrame - outgoing.startFrame,
          fps,
        );
        const incomingFrame = buildEffectShaderFrame(
          incomingEffects.map(({ fx, def: effect }) => ({ def: effect, overrides: fx.overrides })),
          absoluteFrame - incoming.startFrame,
          fps,
        );
        runtime.renderTransitionWithFx(
          transitionFrame.frag,
          staging.out,
          staging.in,
          outgoingFrame.passes,
          incomingFrame.passes,
          transitionFrame.progress,
          transitionFrame.uniforms,
        );
        canvas.style.opacity = '1';
        if (!hasRenderedFrameRef.current) {
          hasRenderedFrameRef.current = true;
          setHasRenderedFrame(true);
        }
        report('ready');
      } catch (error) {
        const reason = glPreviewFailureReason(error);
        failedAdapterRef.current = { definitionKey, reason };
        disposeRuntimeSlot(runtimeRef);
        hideCanvas();
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
  }, [
    definitionKey, def, direction, fit, fps, frame, height, incoming.startFrame,
    incomingEffects, L, onPreviewStatus, outgoing.startFrame, outgoingEffects,
    previewTargetId, staging, type, width, windowStart,
  ]);

  useEffect(() => () => {
    disposeRuntimeSlot(runtimeRef);
  }, [width, height, def?.frag]);

  return (
    <AbsoluteFill>
      <AbsoluteFill aria-hidden style={{ opacity: 0, pointerEvents: 'none' }}>
        <AbsoluteFill>
          <MediaSource item={outgoing} trim={trimOut} fit={fit} elRef={outRef} />
        </AbsoluteFill>
        <AbsoluteFill>
          <MediaSource item={incoming} trim={trimIn} fit={fit} elRef={inRef} />
        </AbsoluteFill>
      </AbsoluteFill>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: hasRenderedFrame ? 1 : 0,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
}
