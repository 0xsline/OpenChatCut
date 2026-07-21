import type { RenderMediaOnWebProgress } from '@remotion/web-renderer';
import type { ComponentType } from 'react';
import type { TimelineCompositionProps } from '../editor/TimelineComposition';
import { GLSL_TRANSITION_TYPES, isAudioTransition, isRasterMediaKind, timelineDuration, type TimelineState } from '../editor/types';
import { scaledExportDimensions, type ExportResolution } from './mediaSettings';

export type BrowserVideoCodec = 'h264' | 'vp8';

type WebRendererModule = Pick<typeof import('@remotion/web-renderer'), 'canRenderMediaOnWeb' | 'renderMediaOnWeb'>;

export interface BrowserExportOptions {
  state: TimelineState;
  codec: BrowserVideoCodec;
  resolution: ExportResolution;
  fps: number;
  signal?: AbortSignal;
  onProgress?: (progress: RenderMediaOnWebProgress) => void;
  loadRenderer?: () => Promise<WebRendererModule>;
  loadComposition?: () => Promise<{ TimelineComposition: ComponentType<TimelineCompositionProps> }>;
}

export type BrowserExportAttempt =
  | { status: 'rendered'; blob: Blob; issues: string[] }
  | { status: 'unsupported'; reason: string; issues: string[] };

export type VideoExportWithFallback<T> =
  | { engine: 'browser'; attempt: Extract<BrowserExportAttempt, { status: 'rendered' }> }
  | { engine: 'server'; value: T; reason: string };

function abortError(): DOMException {
  return new DOMException('Browser export cancelled', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Features that still depend on legacy Remotion Video/OffthreadVideo are kept
 * on the server path until their pixel sources can be consumed by web-renderer.
 */
export function browserTimelineBlocker(state: TimelineState): string | null {
  if (state.items.some((item) => (item.effects?.length ?? 0) > 0)) {
    return '包含 WebGL 片段特效';
  }

  const items = new Map(state.items.map((item) => [item.id, item]));
  const hasGlTransition = (state.transitions ?? []).some((transition) => {
    if (transition.enabled === false || isAudioTransition(transition.type) || !GLSL_TRANSITION_TYPES.has(transition.type)) return false;
    const outgoing = items.get(transition.outgoingItemId);
    const incoming = items.get(transition.incomingItemId);
    const texturable = (item: typeof outgoing) => !!item
      && isRasterMediaKind(item.kind)
      && item.kind !== 'svg'
      && item.kind !== 'gif';
    return texturable(outgoing) && texturable(incoming);
  });
  return hasGlTransition ? '包含 WebGL 转场' : null;
}

/**
 * WebCodecs encoders commonly require even frame dimensions. Remotion's layer
 * canvas uses `Math.ceil(source * scale)`, so find the nearest scale whose
 * actual canvas width and height are both even. Capability detection must use
 * those same dimensions or it can pass while the real encoder still rejects.
 */
export function browserScaledExportDimensions(
  state: Pick<TimelineState, 'width' | 'height'>,
  resolution: ExportResolution,
): { width: number; height: number; scale: number } {
  const sourceWidth = Math.max(1, Number(state.width) || 1920);
  const sourceHeight = Math.max(1, Number(state.height) || 1080);
  const base = scaledExportDimensions(state, resolution);
  const baseWidth = Math.max(2, Math.ceil(sourceWidth * base.scale));
  const baseHeight = Math.max(2, Math.ceil(sourceHeight * base.scale));
  if (baseWidth % 2 === 0 && baseHeight % 2 === 0) {
    return { width: baseWidth, height: baseHeight, scale: base.scale };
  }

  const nearestEvenWidth = Math.max(2, Math.round(baseWidth / 2) * 2);
  const nearestEvenHeight = Math.max(2, Math.round(baseHeight / 2) * 2);
  let best: { width: number; height: number; scale: number; distance: number } | null = null;
  for (let widthOffset = -32; widthOffset <= 32; widthOffset += 2) {
    const width = nearestEvenWidth + widthOffset;
    if (width < 2) continue;
    for (let heightOffset = -32; heightOffset <= 32; heightOffset += 2) {
      const height = nearestEvenHeight + heightOffset;
      if (height < 2) continue;
      const lower = Math.max((width - 1) / sourceWidth, (height - 1) / sourceHeight);
      const upper = Math.min(width / sourceWidth, height / sourceHeight);
      if (lower >= upper || upper < 0.1 || lower > 4) continue;
      const scale = base.scale > lower && base.scale <= upper
        ? base.scale
        : base.scale > upper ? upper : (lower + upper) / 2;
      if (Math.ceil(sourceWidth * scale) !== width || Math.ceil(sourceHeight * scale) !== height) continue;
      const distance = Math.abs(scale - base.scale);
      if (!best || distance < best.distance) best = { width, height, scale, distance };
    }
  }

  if (best) return { width: best.width, height: best.height, scale: best.scale };
  return base;
}

export async function renderTimelineInBrowser(options: BrowserExportOptions): Promise<BrowserExportAttempt> {
  const { state, codec, resolution, fps, signal, onProgress } = options;
  if (signal?.aborted) throw abortError();
  if (fps !== state.fps) {
    return {
      status: 'unsupported',
      reason: '浏览器快导暂不转换时间线帧率',
      issues: [`timeline=${state.fps}fps, requested=${fps}fps`],
    };
  }
  const blocker = browserTimelineBlocker(state);
  if (blocker) return { status: 'unsupported', reason: blocker, issues: [blocker] };

  const { width, height, scale } = browserScaledExportDimensions(state, resolution);
  const container = codec === 'h264' ? 'mp4' : 'webm';
  const audioCodec = codec === 'h264' ? 'aac' : 'opus';
  const renderer = await (options.loadRenderer ?? (() => import('@remotion/web-renderer')))();
  if (signal?.aborted) throw abortError();

  const capability = await renderer.canRenderMediaOnWeb({
    container,
    videoCodec: codec,
    audioCodec,
    width,
    height,
    videoBitrate: 'high',
    audioBitrate: 'high',
  });
  const issues = capability.issues.map((issue) => issue.message);
  if (!capability.canRender) {
    return {
      status: 'unsupported',
      reason: issues[0] ?? '当前浏览器不支持此编码配置',
      issues,
    };
  }
  if (signal?.aborted) throw abortError();

  const props: TimelineCompositionProps = { state, transparent: false, browserRenderer: true };
  try {
    const { TimelineComposition } = await (options.loadComposition ?? (() => import('../editor/TimelineComposition')))();
    if (signal?.aborted) throw abortError();
    const result = await renderer.renderMediaOnWeb({
      composition: {
        id: 'openchatcut-timeline-browser',
        component: TimelineComposition,
        durationInFrames: Math.max(1, timelineDuration(state)),
        fps: state.fps,
        width: state.width,
        height: state.height,
        defaultProps: props,
      },
      inputProps: props,
      container,
      videoCodec: codec,
      audioCodec,
      scale,
      signal,
      onProgress,
      hardwareAcceleration: 'prefer-hardware',
      pageResponsiveness: 'medium',
      videoBitrate: 'high',
      audioBitrate: 'high',
      transparent: false,
    });
    if (signal?.aborted) throw abortError();
    const blob = await result.getBlob();
    if (signal?.aborted) throw abortError();
    return { status: 'rendered', blob, issues };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  }
}

/** Keep fallback policy in one testable place: abort never starts a server job. */
export async function exportVideoWithFallback<T>({
  browser,
  server,
  onFallback,
}: {
  browser: () => Promise<BrowserExportAttempt>;
  server: () => Promise<T>;
  onFallback?: (reason: string) => void;
}): Promise<VideoExportWithFallback<T>> {
  try {
    const attempt = await browser();
    if (attempt.status === 'rendered') return { engine: 'browser', attempt };
    onFallback?.(attempt.reason);
    return { engine: 'server', value: await server(), reason: attempt.reason };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const reason = error instanceof Error ? error.message : '浏览器快导失败';
    onFallback?.(reason);
    return { engine: 'server', value: await server(), reason };
  }
}
