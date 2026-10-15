import type { RenderMediaOnWebProgress } from '@remotion/web-renderer';
import type { ComponentType } from 'react';
import type { TimelineCompositionProps } from '../editor/TimelineComposition';
import { timelineDuration, type ProjectDoc, type TimelineState } from '../editor/types';
import { resolveTimelineRenderPlan } from '../editor/sequenceGraph';
import { webScaledExportDimensions, type ExportResolution } from './mediaSettings';
import {
  browserEncoderBitrate,
  browserEncodingContentType,
  browserHardwareAcceleration,
  probeBrowserEncoder,
  type BrowserHardwareAcceleration,
  type VideoEncoderSupportProbe,
} from './browserEncoderProbe';
// The local renderer's per-frame budget, shared so both engines agree.
import { DEFAULT_RENDER_TIMEOUT_MS } from '../../remotion/render-timeout.mjs';

/**
 * Route notices, not errors: each is shown while the local renderer takes
 * over. The WebCodecs detail behind them stays in the inspection issues and
 * the console, where it helps diagnose the machine without reading like the
 * export failed.
 */
export const BROWSER_ENCODER_UNSUPPORTED_REASON = '浏览器编码器不支持此导出规格';
export const BROWSER_RENDER_INCOMPLETE_REASON = '浏览器快导未能完成';
// Mediabunny's messages when WebCodecs refuses the encoder the render asked for.
const ENCODER_REFUSED = /encoder configuration .* is not supported|VideoEncoder is not supported|cannot be encoded by this browser/i;


export type BrowserVideoCodec = 'h264' | 'vp8';
/** Server mezzanine codecs are accepted on the route planner, then forced off the browser path. */
export type PlannedVideoCodec = BrowserVideoCodec | 'prores';

type WebRendererModule = Pick<typeof import('@remotion/web-renderer'), 'canRenderMediaOnWeb' | 'renderMediaOnWeb'>;

export interface BrowserExportOptions {
  state: TimelineState;
  project?: ProjectDoc;
  timelineId?: string;
  codec: PlannedVideoCodec;
  resolution: ExportResolution;
  fps: number;
  videoBitrate?: number;
  signal?: AbortSignal;
  onProgress?: (progress: RenderMediaOnWebProgress) => void;
  loadRenderer?: () => Promise<WebRendererModule>;
  loadComposition?: () => Promise<{ TimelineComposition: ComponentType<TimelineCompositionProps> }>;
  /** Stands in for VideoEncoder.isConfigSupported; null means WebCodecs is missing. */
  probeVideoEncoder?: VideoEncoderSupportProbe | null;
}

export type BrowserExportAttempt =
  | { status: 'rendered'; blob: Blob; issues: string[] }
  | { status: 'unsupported'; reason: string; issues: string[] };
export type BrowserExportInspection =
  | { status: 'supported'; issues: string[]; powerEfficient?: boolean }
  | Extract<BrowserExportAttempt, { status: 'unsupported' }>;


export type VideoExportWithFallback<T> =
  | { engine: 'browser'; attempt: Extract<BrowserExportAttempt, { status: 'rendered' }> }
  | { engine: 'server'; value: T; reason: string };

function abortError(): DOMException {
  return new DOMException('Browser export cancelled', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** The neutral notice for a browser render that threw before the local renderer took over. */
export function browserFallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return ENCODER_REFUSED.test(message) ? BROWSER_ENCODER_UNSUPPORTED_REASON : BROWSER_RENDER_INCOMPLETE_REASON;
}

/**
 * Decide whether a timeline can use the in-browser WebCodecs fast-export path.
 *
 * Historically this returned a reason to bar timelines containing WebGL clip
 * effects (`item.effects`) and GLSL transitions, because the web-renderer
 * frame grabber was not proven to capture a manually-drawn WebGL <canvas>.
 *
 * That assumption has been verified in this branch: a real `TimelineComposition`
 * containing multiple WebGL effects (bloom/pixelate/duotone/vignette/fisheye/crt)
 * and several GLSL transitions rendered through `@remotion/web-renderer` at
 * 1080p × 360f produces a valid H264 MP4 with 360 distinct frames and zero black
 * frames (ffprobe + blackdetect + per-frame sampling). WebCodecs therefore
 * carries these timelines, so they are no longer barred here. The fallback in
 * `exportVideoWithFallback` still routes any per-hardware failure to the server.
 *
 * Non-raster sources (svg/gif) and frame-rate retiming are handled separately by
 * `staticBrowserBlocker`.
 */
export function browserTimelineBlocker(state: TimelineState, project?: ProjectDoc, timelineId?: string): string | null {
  void state;
  void project;
  void timelineId;
  return null;
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
  width: number;
  height: number;
  scale: number;
  videoBitrate: number | 'high';
  hardwareAcceleration: BrowserHardwareAcceleration;
  issues: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function loadBrowserRenderConfig(
  options: BrowserExportOptions,
): Promise<BrowserRenderConfig | Extract<BrowserExportAttempt, { status: 'unsupported' }>> {
  const { state, codec, resolution, videoBitrate, signal } = options;
  if (codec === 'prores') {
    return { status: 'unsupported', reason: 'ProRes 母带仅支持本机渲染', issues: ['codec=prores'] };
  }
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
  // canRenderMediaOnWeb only asks about a 1280x720 frame with no hardware
  // preference, which passes wherever a software encoder exists. The render
  // then asks for this size with prefer-hardware and throws when the GPU
  // encoder is missing (disabled acceleration, GPU-crash fallback, VM/RDP).
  // Asking that exact question first routes such machines to the local
  // renderer before any frame is drawn.
  const hardwareAcceleration = browserHardwareAcceleration(width, height);
  const encoder = await probeBrowserEncoder(
    { codec, width, height, videoBitrate: resolvedVideoBitrate, hardwareAcceleration },
    options.probeVideoEncoder,
  );
  throwIfAborted(signal);
  if (!encoder.supported) {
    return { status: 'unsupported', reason: BROWSER_ENCODER_UNSUPPORTED_REASON, issues: [...issues, encoder.detail] };
  }
  return {
    renderer, container, audioCodec, width, height, scale,
    videoBitrate: resolvedVideoBitrate, hardwareAcceleration, issues,
  };
}
function staticBrowserBlocker(
  options: BrowserExportOptions,
): Extract<BrowserExportAttempt, { status: 'unsupported' }> | null {
  if (options.codec === 'prores') {
    return {
      status: 'unsupported',
      reason: 'ProRes 母带仅支持本机渲染',
      issues: ['codec=prores'],
    };
  }
  if (options.fps !== options.state.fps) {
    return {
      status: 'unsupported',
      reason: '浏览器快导暂不转换时间线帧率',
      issues: [`timeline=${options.state.fps}fps, requested=${options.fps}fps`],
    };
  }
  const blocker = browserTimelineBlocker(options.state, options.project, options.timelineId);
  return blocker ? { status: 'unsupported', reason: blocker, issues: [blocker] } : null;
}

async function isBrowserEncodingPowerEfficient(
  options: BrowserExportOptions,
  config: BrowserRenderConfig,
): Promise<boolean | undefined> {
  const capabilities = globalThis.navigator?.mediaCapabilities;
  if (!capabilities?.encodingInfo || options.codec === 'prores') return undefined;
  const { width, height } = config;
  const bitrate = browserEncoderBitrate(options.codec, width, height, config.videoBitrate);
  try {
    // Chromium only answers type 'record' behind its MediaCapabilitiesEncodingInfo
    // flag and rejects it otherwise; that lands in the catch below.
    const info = await capabilities.encodingInfo({
      type: 'record',
      video: {
        contentType: browserEncodingContentType(options.codec, { width, height, fps: options.fps, bitrate }),
        width,
        height,
        bitrate,
        framerate: options.fps,
      },
    });
    return info.powerEfficient;
  } catch {
    return undefined;
  }
}

export async function inspectBrowserExport(options: BrowserExportOptions): Promise<BrowserExportInspection> {
  throwIfAborted(options.signal);
  const blocker = staticBrowserBlocker(options);
  if (blocker) return blocker;
  const config = await loadBrowserRenderConfig(options);
  if ('status' in config) return config;
  return {
    status: 'supported',
    issues: config.issues,
    powerEfficient: await isBrowserEncodingPowerEfficient(options, config),
  };
}


async function executeBrowserRender(
  options: BrowserExportOptions,
  config: BrowserRenderConfig,
): Promise<Extract<BrowserExportAttempt, { status: 'rendered' }>> {
  const { state, project, timelineId, codec, signal, onProgress } = options;
  // Invariant: loadBrowserRenderConfig rejected prores before any render config existed.
  if (codec === 'prores') throw new Error('prores must be rejected by loadBrowserRenderConfig');
  const props: TimelineCompositionProps = { state, project, timelineId, transparent: false, browserRenderer: true };
  try {
    const { TimelineComposition } = await (options.loadComposition ?? (() => import('../editor/TimelineComposition')))();
    throwIfAborted(signal);
    const result = await config.renderer.renderMediaOnWeb({
      composition: {
        id: 'openchatcut-timeline-browser',
        component: TimelineComposition,
        durationInFrames: Math.max(1, project && timelineId ? resolveTimelineRenderPlan(project, timelineId).durationInFrames : timelineDuration(state)),
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
      // The value the capability probe already confirmed (browserHardwareAcceleration).
      hardwareAcceleration: config.hardwareAcceleration,
      pageResponsiveness: 'medium',
      // Without this, @remotion/web-renderer falls back to Remotion's 30s
      // default and delayRender reports 30s minus its own 2s buffer — the
      // "not cleared after 28000ms" failure users hit on sources that are
      // merely slow to open (large or long-GOP files, software HEVC decode,
      // cold disk), while the same project rendered fine on the local engine.
      // This bounds one frame, not the export: it is a hang guard, and it is
      // also what triggers Remotion's one-shot frame retry. See
      // remotion/render-timeout.mjs for why the budget is what it is.
      delayRenderTimeoutInMilliseconds: DEFAULT_RENDER_TIMEOUT_MS,
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
  throwIfAborted(options.signal);
  const blocker = staticBrowserBlocker(options);
  if (blocker) return blocker;
  const config = await loadBrowserRenderConfig(options);
  if ('status' in config) return config;
  throwIfAborted(options.signal);
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
