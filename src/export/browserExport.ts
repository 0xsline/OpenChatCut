import type { RenderMediaOnWebProgress } from '@remotion/web-renderer';
import type { ComponentType } from 'react';
import type { TimelineCompositionProps } from '../editor/TimelineComposition';
import { GLSL_TRANSITION_TYPES, isAudioTransition, isRasterMediaKind, timelineDuration, type TimelineState } from '../editor/types';
import { webScaledExportDimensions, type ExportResolution } from './mediaSettings';

export type BrowserVideoCodec = 'h264' | 'vp8';

type WebRendererModule = Pick<typeof import('@remotion/web-renderer'), 'canRenderMediaOnWeb' | 'renderMediaOnWeb'>;

export interface BrowserExportOptions {
  state: TimelineState;
  codec: BrowserVideoCodec;
  resolution: ExportResolution;
  fps: number;
  videoBitrate?: number;
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

/** Use the shared codec-safe dimensions for capability checks and rendering. */
export function browserScaledExportDimensions(
  state: Pick<TimelineState, 'width' | 'height'>,
  resolution: ExportResolution,
): { width: number; height: number; scale: number } {
  return webScaledExportDimensions(state, resolution);
}

interface BrowserRenderConfig {
  renderer: WebRendererModule;
  container: 'mp4' | 'webm';
  audioCodec: 'aac' | 'opus';
  scale: number;
  videoBitrate: number | 'high';
  issues: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function loadBrowserRenderConfig(
  options: BrowserExportOptions,
): Promise<BrowserRenderConfig | Extract<BrowserExportAttempt, { status: 'unsupported' }>> {
  const { state, codec, resolution, videoBitrate, signal } = options;
  const { width, height, scale } = browserScaledExportDimensions(state, resolution);
  const container = codec === 'h264' ? 'mp4' : 'webm';
  const audioCodec = codec === 'h264' ? 'aac' : 'opus';
  const resolvedVideoBitrate = videoBitrate ?? 'high';
  const renderer = await (options.loadRenderer ?? (() => import('@remotion/web-renderer')))();
  throwIfAborted(signal);
  const capability = await renderer.canRenderMediaOnWeb({
    container,
    videoCodec: codec,
    audioCodec,
    width,
    height,
    videoBitrate: resolvedVideoBitrate,
    audioBitrate: 'high',
  });
  const issues = capability.issues.map((issue) => issue.message);
  if (!capability.canRender) {
    return { status: 'unsupported', reason: issues[0] ?? '当前浏览器不支持此编码配置', issues };
  }
  return { renderer, container, audioCodec, scale, videoBitrate: resolvedVideoBitrate, issues };
}

async function executeBrowserRender(
  options: BrowserExportOptions,
  config: BrowserRenderConfig,
): Promise<Extract<BrowserExportAttempt, { status: 'rendered' }>> {
  const { state, codec, signal, onProgress } = options;
  const props: TimelineCompositionProps = { state, transparent: false, browserRenderer: true };
  try {
    const { TimelineComposition } = await (options.loadComposition ?? (() => import('../editor/TimelineComposition')))();
    throwIfAborted(signal);
    const result = await config.renderer.renderMediaOnWeb({
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
      container: config.container,
      videoCodec: codec,
      audioCodec: config.audioCodec,
      scale: config.scale,
      signal,
      onProgress,
      hardwareAcceleration: 'prefer-hardware',
      pageResponsiveness: 'medium',
      videoBitrate: config.videoBitrate,
      audioBitrate: 'high',
      transparent: false,
    });
    throwIfAborted(signal);
    const blob = await result.getBlob();
    throwIfAborted(signal);
    return { status: 'rendered', blob, issues: config.issues };
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

export async function renderTimelineInBrowser(options: BrowserExportOptions): Promise<BrowserExportAttempt> {
  const { state, fps, signal } = options;
  throwIfAborted(signal);
  if (fps !== state.fps) {
    return {
      status: 'unsupported',
      reason: '浏览器快导暂不转换时间线帧率',
      issues: [`timeline=${state.fps}fps, requested=${fps}fps`],
    };
  }
  const blocker = browserTimelineBlocker(state);
  if (blocker) return { status: 'unsupported', reason: blocker, issues: [blocker] };
  const config = await loadBrowserRenderConfig(options);
  if ('status' in config) return config;
  throwIfAborted(signal);
  return executeBrowserRender(options, config);
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
