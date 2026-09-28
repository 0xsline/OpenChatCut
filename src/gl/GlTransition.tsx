import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Img, OffthreadVideo, Video, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { Video as MediaVideo } from '@remotion/media';
import { createGlRuntime, type GlRuntime } from './runtime';
import { cubeSettled, ensureCube } from './fx/cube';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import { buildEffectShaderFrame, buildTransitionShaderFrame } from './shaderFrame';
import { glPreviewFailureReason } from './previewAdapter';
import type { SelectedPreviewFallbackReason, SelectedPreviewStatusListener } from './previewAdapter';
import { GLSL_TRANSITIONS } from './transitions';
import { glEffects } from './clipEffects';
import { sourceSize, useCapturedFrame, type CapturedFrame } from './capturedFrame';
import type { AspectFit, GlslTransitionType, TimelineItem, TransitionDirection } from '../editor/types';
import { backgroundFillAppearanceFor, backgroundFillFilter } from '../editor/backgroundFill';
import { clipOpacityAt } from '../editor/clipFade';
import { offthreadTrimBefore, offthreadVideoTransparent, useRuntimeVideoDecoder, type ServerVideoDecoder } from '../editor/serverVideoDecoder';

// One GLSL transition window straddling the cut from R to R+L. A muted,
// frame-synced media pair feeds 2D staging canvases, each clip's ordered effect
// graph, then the transition shader in one WebGL context. TimelineComposition's
// effect-aware CSS composition remains visible until the exact GL frame is ready.
// DOM clips (MG/text) stay on that CSS path because they cannot be textured.
//
// A server render decodes both video inputs with the export's decoder, like
// the clip layers beneath the window: <OffthreadVideo> under 'offthread'
// (Windows, #162), @remotion/media otherwise. HTML5 <video> inputs were drawn
// with whatever they showed before this frame's seek (the seek runs in a
// passive effect, after this layout effect), and beside <OffthreadVideo>
// layers that seek sometimes never settled, holding the export until the
// ten-minute frame budget expired. Only the Player keeps live <video> elements.

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
  outgoingBackgroundFill?: boolean;
  incomingBackgroundFill?: boolean;
  previewTargetId?: string;
  onReadyChange?: (ready: boolean) => void;
  onPreviewStatus?: SelectedPreviewStatusListener;
}

type MediaEl = HTMLVideoElement | HTMLImageElement;
/** What a staging canvas draws: a live element, or a render's captured frame. */
type InputSource = MediaEl | HTMLCanvasElement;

const isReady = (el: MediaEl): boolean =>
  el instanceof HTMLVideoElement ? el.readyState >= 2 && !el.seeking : el.complete;

function drawPlaced(ctx: CanvasRenderingContext2D, el: InputSource, fit: AspectFit, overscan = 1): void {
  const source = sourceSize(el);
  if (!source.width || !source.height) return;
  const scale = (fit === 'cover'
    ? Math.max(ctx.canvas.width / source.width, ctx.canvas.height / source.height)
    : Math.min(ctx.canvas.width / source.width, ctx.canvas.height / source.height)) * overscan;
  const width = source.width * scale;
  const height = source.height * scale;
  ctx.drawImage(el, (ctx.canvas.width - width) / 2, (ctx.canvas.height - height) / 2, width, height);
}

function drawMediaFrame(
  ctx: CanvasRenderingContext2D,
  el: InputSource,
  fit: AspectFit,
  item: TimelineItem,
  backgroundFill: boolean,
  opacity: number,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.globalAlpha = opacity;
  if (!backgroundFill) {
    drawPlaced(ctx, el, fit);
    ctx.restore();
    return;
  }
  const appearance = backgroundFillAppearanceFor(item, ctx.canvas.width, ctx.canvas.height);
  const filters = item.filters;
  ctx.save();
  ctx.filter = backgroundFillFilter(appearance, filters);
  drawPlaced(ctx, el, 'cover', appearance.overscanScale);
  ctx.restore();
  ctx.save();
  ctx.filter = `brightness(${filters?.brightness ?? 1}) contrast(${filters?.contrast ?? 1}) saturate(${filters?.saturate ?? 1}) blur(${filters?.blur ?? 0}px)`;
  drawPlaced(ctx, el, 'contain');
  ctx.restore();
  ctx.restore();
}

function MediaSource({ item, trim, fit, elRef, decoder, onVideoFrame }: {
  item: TimelineItem;
  trim: number;
  fit: AspectFit;
  elRef: React.MutableRefObject<MediaEl | null>;
  /** A render's decoder, which hands every decoded frame to onVideoFrame; null in the Player. */
  decoder: ServerVideoDecoder | null;
  onVideoFrame: (source: CanvasImageSource) => void;
}) {
  const { fps } = useVideoConfig();
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: fit };
  if (item.kind === 'image') {
    // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
    return <Img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={item.src!} style={style} />;
  }
  // Muted: the original clip sequences own audio; this element only feeds GL textures.
  if (decoder === 'offthread') {
    return <OffthreadVideo src={item.src!} trimBefore={offthreadTrimBefore(trim, fps)} playbackRate={item.playbackRate ?? 1} muted
      transparent={offthreadVideoTransparent(item.src!)} onVideoFrame={onVideoFrame} style={style} />;
  }
  if (decoder === 'webcodecs') {
    return <MediaVideo src={item.src!} trimBefore={trim} playbackRate={item.playbackRate ?? 1} muted headless onVideoFrame={onVideoFrame} />;
  }
  return <Video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} src={item.src!} trimBefore={trim} playbackRate={item.playbackRate ?? 1} muted style={style} />;
}

export function GlTransition({ type, direction, L, windowStart, outgoing, incoming, trimOut, trimIn, width, height, fit, outgoingBackgroundFill = false, incomingBackgroundFill = false, customFrag, customUniforms, previewTargetId, onPreviewStatus, onReadyChange }: GlTransitionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rendering = getRemotionEnvironment().isRendering;
  const runtimeDecoder = useRuntimeVideoDecoder();
  const inputDecoder = rendering ? runtimeDecoder : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const outRef = useRef<MediaEl | null>(null);
  const inRef = useRef<MediaEl | null>(null);
  const { capturedRef: outCapturedRef, onVideoFrame: captureOutgoing } = useCapturedFrame(frame);
  const { capturedRef: inCapturedRef, onVideoFrame: captureIncoming } = useCapturedFrame(frame);
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
    const handle = rendering ? delayRender(`gl-transition ${type} f${frame}`) : null;
    let done = false;
    let raf = 0;
    const report = (phase: 'waiting' | 'ready' | 'fallback', fallbackReason?: SelectedPreviewFallbackReason) => {
      onReadyChange?.(phase === 'ready');
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
    // A render draws a video input only from the frame its decoder captured for
    // this frame. Images, and the Player's live elements, report readiness.
    const inputSource = (
      item: TimelineItem,
      elRef: React.MutableRefObject<MediaEl | null>,
      captured: CapturedFrame | null,
    ): InputSource | null => {
      if (rendering && item.kind !== 'image') return captured?.frame === frame ? captured.canvas : null;
      const el = elRef.current;
      return el && isReady(el) ? el : null;
    };
    const tick = () => {
      const outgoingSource = inputSource(outgoing, outRef, outCapturedRef.current);
      const incomingSource = inputSource(incoming, inRef, inCapturedRef.current);
      if (!outgoingSource || !incomingSource
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
        const absoluteFrame = windowStart + frame;
        const outgoingOpacity = clipOpacityAt(outgoing, absoluteFrame - outgoing.startFrame);
        const incomingOpacity = clipOpacityAt(incoming, absoluteFrame - incoming.startFrame);
        drawMediaFrame(
          outgoingContext,
          outgoingSource,
          fit,
          outgoing,
          outgoingBackgroundFill,
          outgoingOpacity,
        );
        drawMediaFrame(
          incomingContext,
          incomingSource,
          fit,
          incoming,
          incomingBackgroundFill,
          incomingOpacity,
        );
        const transitionFrame = buildTransitionShaderFrame(def, {
          sequenceFrame: frame,
          durationInFrames: L,
          windowStartFrame: windowStart,
          fps,
          width,
          height,
          direction,
        });
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
          { outgoing: outgoingOpacity, incoming: incomingOpacity },
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
    definitionKey, def, direction, fit, fps, frame, height, incoming, incomingBackgroundFill, inCapturedRef,
    incomingEffects, L, onPreviewStatus, onReadyChange, outCapturedRef, outgoing, outgoingBackgroundFill, outgoingEffects,
    previewTargetId, rendering, staging, type, width, windowStart,
  ]);

  useEffect(() => () => {
    disposeRuntimeSlot(runtimeRef);
  }, [width, height, def?.frag]);

  return (
    <AbsoluteFill>
      <AbsoluteFill aria-hidden style={{ opacity: 0, pointerEvents: 'none' }}>
        <AbsoluteFill>
          <MediaSource item={outgoing} trim={trimOut} fit={fit} elRef={outRef} decoder={inputDecoder} onVideoFrame={captureOutgoing} />
        </AbsoluteFill>
        <AbsoluteFill>
          <MediaSource item={incoming} trim={trimIn} fit={fit} elRef={inRef} decoder={inputDecoder} onVideoFrame={captureIncoming} />
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
