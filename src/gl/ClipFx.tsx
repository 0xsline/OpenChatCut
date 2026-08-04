import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Img, Video, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { Video as MediaVideo } from '@remotion/media';
import { createGlRuntime, type GlRuntime } from './runtime';
import { cubeSettled, ensureCube } from './fx/cube';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import { buildEffectShaderFrame } from './shaderFrame';
import { glPreviewFailureReason } from './previewAdapter';
import type { SelectedPreviewFallbackReason, SelectedPreviewStatusListener } from './previewAdapter';
import type { AspectFit, TimelineItem } from '../editor/types';
import { sourceFrameAt } from '../editor/sourceLimit';
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
  frameOffset?: number;
  onPreviewStatus?: SelectedPreviewStatusListener;
}

type MediaEl = HTMLVideoElement | HTMLImageElement;

const isReady = (el: MediaEl): boolean =>
  el instanceof HTMLVideoElement ? el.readyState >= 2 && !el.seeking : el.complete;

// contain/cover placement matching MediaFill's objectFit, so GL frames align
// with the rest of the composition.
function drawFit(ctx: CanvasRenderingContext2D, source: CanvasImageSource, fit: AspectFit): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const dimensions = source as CanvasImageSource & {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    width?: number;
    height?: number;
  };
  const nw = dimensions.videoWidth
    ?? dimensions.naturalWidth
    ?? dimensions.displayWidth
    ?? dimensions.width
    ?? 0;
  const nh = dimensions.videoHeight
    ?? dimensions.naturalHeight
    ?? dimensions.displayHeight
    ?? dimensions.height
    ?? 0;
  ctx.clearRect(0, 0, W, H);
  if (!nw || !nh) return;
  const scale = fit === 'cover' ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function ClipFx({ item, fit, width, height, frameOffset = 0, onPreviewStatus }: ClipFxProps) {
  const frame = useCurrentFrame() + frameOffset;
  const { fps } = useVideoConfig();
  const isRendering = getRemotionEnvironment().isRendering;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceLayerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const elRef = useRef<MediaEl | null>(null);
  const failedAdapterRef = useRef<{ definitionKey: string; reason: SelectedPreviewFallbackReason } | null>(null);
  const stagedRenderKeyRef = useRef<string | null>(null);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const trimBefore = sourceFrameAt(item, frameOffset);
  // MediaVideo resolves decoded frames by presentation timestamp. Seeking at an
  // exact timeline-frame boundary can select the previous frame for fractional
  // source rates (for example 30000/1001), unlike the ordinal OffthreadVideo
  // path used without effects. The midpoint keeps both export paths aligned.
  const exportTrimBefore = trimBefore + 0.5;

  const staging = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }, [width, height]);

  const active = useMemo(() => glEffects(item), [item]);
  const definitionKey = useMemo(
    () => active.map(({ def }) => `${def.id}:${def.frag}`).join('\u0000'),
    [active],
  );
  const renderKey = useMemo(
    () => JSON.stringify([frame, fit, width, height, active.map(({ fx }) => [fx.id, fx.overrides])]),
    [frame, fit, width, height, active],
  );
  const onVideoFrame = useCallback(
    (source: CanvasImageSource) => {
      if (!isRendering) return;
      const ctx = staging.getContext('2d');
      if (!ctx) return;
      drawFit(ctx, source, fit);
      stagedRenderKeyRef.current = renderKey;
    },
    [fit, isRendering, renderKey, staging],
  );

  useEffect(() => {
    if (!onPreviewStatus) return;
    const targetId = item.id;
    return () => {
      onPreviewStatus({
        kind: 'effect',
        targetId,
        adapter: 'gl-effect',
        phase: 'inactive',
      });
    };
  }, [item.id, onPreviewStatus]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || active.length === 0) return;
    const handle = isRendering ? delayRender(`clip-fx ${active.map(({ def }) => def.id).join(',')}`) : null;
    let done = false;
    let raf = 0;
    const report = (phase: 'waiting' | 'ready' | 'fallback', fallbackReason?: SelectedPreviewFallbackReason) => {
      onPreviewStatus?.({
        kind: 'effect',
        targetId: item.id,
        adapter: 'gl-effect',
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
    const priorFailure = failedAdapterRef.current?.definitionKey === definitionKey
      ? failedAdapterRef.current.reason
      : null;
    if (priorFailure) {
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
    // .cube LUT is loaded first; tick waits until loading has settled. A failed
    // LUT is an intentional pass-through with intensity=0 in fxPasses().
    for (const { def } of active) if (def.cube) void ensureCube(def.cube);
    const tick = () => {
      const exportVideo = isRendering && item.kind !== 'image';
      const el = elRef.current;
      const mediaReady = exportVideo
        ? stagedRenderKeyRef.current === renderKey
        : !!el && isReady(el);
      if (!mediaReady) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      if (active.some(({ def }) => def.cube && !cubeSettled(def.cube))) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      try {
        const runtime = ensureRuntimeSlot(runtimeRef, () => createGlRuntime(canvas));
        const ctx = staging.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        if (!exportVideo && el) drawFit(ctx, el, fit);
        const shaderFrame = buildEffectShaderFrame(
          active.map(({ fx, def }) => ({ def, overrides: fx.overrides })),
          frame,
          fps,
        );
        runtime.renderFxChain(shaderFrame.passes, staging);
        // Make the freshly drawn canvas authoritative before unblocking export;
        // React state then preserves the same choice for subsequent renders.
        canvas.style.opacity = '1';
        if (sourceLayerRef.current) sourceLayerRef.current.style.opacity = '0';
        if (!isRendering) setRenderedKey(renderKey);
        report('ready');
      } catch (error) {
        const reason = glPreviewFailureReason(error);
        failedAdapterRef.current = { definitionKey, reason };
        disposeRuntimeSlot(runtimeRef);
        report('fallback', reason);
        console.error('[clip-fx]', error);
      }
      finish();
    };
    tick();
    return () => { cancelAnimationFrame(raf); finish(); };
  }, [active, definitionKey, fit, staging, item.id, item.kind, frame, fps, isRendering, renderKey, onPreviewStatus]);

  useEffect(() => () => {
    disposeRuntimeSlot(runtimeRef);
  }, [width, height, definitionKey]);

  const showingShaderFrame = renderedKey === renderKey;
  if (active.length === 0) return null;
  return (
    <AbsoluteFill>
      {/* The source is the honest Player fallback while media/GL is unavailable.
          Once this exact frame+parameter key is drawn, only the GL canvas shows. */}
      <AbsoluteFill ref={sourceLayerRef} style={{ opacity: showingShaderFrame ? 0 : 1, pointerEvents: 'none' }}>
        {item.kind === 'image'
          // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
          ? <Img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={item.src!} style={{ width: '100%', height: '100%', objectFit: fit }} />
          : isRendering
            ? <MediaVideo src={item.src!} trimBefore={exportTrimBefore} playbackRate={item.playbackRate ?? 1} muted headless onVideoFrame={onVideoFrame} />
            : <Video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} src={item.src!} trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1} muted style={{ width: '100%', height: '100%', objectFit: fit }} />}
      </AbsoluteFill>
      <canvas ref={canvasRef} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: showingShaderFrame ? 1 : 0 }} />
    </AbsoluteFill>
  );
}
