import { timelineDuration } from '../editor/types';
import { recordExport } from '../persist/exportHistoryStore';
import {
  browserScaledExportDimensions,
  isAbortError,
  renderTimelineInBrowser,
  type BrowserExportAttempt,
  type BrowserExportOptions,
} from './browserExport';
import { removeStagedBrowserExport, stageBrowserExport } from './browserExportStage';
import { writeBlobToDestination, type ExportDestination } from './exportDestination';
import { planVideoExportRoute, recordExportPerformance, type ExportRoutePlan } from './exportRoutePlanner';
import { isServerRenderError } from './serverExportOperation';
import type {
  BrowserAbortRef,
  ExportEngineInfo,
  ExportJobResult,
  ExportProgress,
  ExportQaUiState,
  RenderEngine,
  StateSetter,
  Translate,
  UseExportWorkflowOptions,
} from './exportWorkflowTypes';

interface VideoExportContext {
  autoQaEnabled: boolean;
  browserAbortRef: BrowserAbortRef;
  destination: ExportDestination;
  exportServerVideo: (signal?: AbortSignal) => Promise<ExportJobResult>;
  options: UseExportWorkflowOptions;
  setBusy: StateSetter<string | null>;
  setEngineInfo: StateSetter<ExportEngineInfo | null>;
  setEngineReason: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setQa: StateSetter<ExportQaUiState | null>;
  setRenderEngine: StateSetter<RenderEngine>;
  t: Translate;
  verifyCompletedExport: (completed: ExportJobResult) => Promise<void>;
}

function browserProgress(context: VideoExportContext): NonNullable<BrowserExportOptions['onProgress']> {
  return (snapshot) => {
    context.setRenderEngine('browser');
    const percent = Math.min(98, Math.max(1, Math.round(snapshot.progress * 98)));
    context.setBusy(context.t('浏览器渲染中…'));
    context.setProgress((current) => current ? {
      ...current,
      phase: 'rendering',
      percent: Math.max(current.percent, percent),
      processedFrames: snapshot.encodedFrames,
      totalFrames: Math.max(1, timelineDuration(context.options.state)),
      detail: context.t('WebCodecs 浏览器加速'),
    } : current);
  };
}

function browserOptions(context: VideoExportContext, signal: AbortSignal): BrowserExportOptions {
  const { state, codec, resolution, fps, requestedVideoBitrate } = context.options;
  return {
    state,
    codec,
    resolution,
    fps,
    videoBitrate: requestedVideoBitrate,
    signal,
    onProgress: browserProgress(context),
  };
}

function setPlannedRoute(context: VideoExportContext, plan: ExportRoutePlan): void {
  context.setRenderEngine(plan.route === 'browser' ? 'browser' : 'server');
  context.setEngineInfo(plan.engine);
  context.setEngineReason(plan.reason);
  context.setProgress((current) => current ? { ...current, detail: context.t(plan.reason) } : current);
}

function switchToServer(context: VideoExportContext, engine: ExportEngineInfo, reason: string): void {
  context.setRenderEngine('server');
  context.setEngineInfo(engine);
  context.setEngineReason(reason);
  context.setBusy(context.t('切换兼容渲染…'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'preparing',
    percent: 0,
    processedFrames: undefined,
    totalFrames: undefined,
    detail: context.t('浏览器快导不可用：{reason}，已切换兼容渲染', { reason: context.t(reason) }),
  } : current);
}

function switchToBrowser(context: VideoExportContext, engine: ExportEngineInfo, reason: string): void {
  context.setRenderEngine('browser');
  context.setEngineInfo(engine);
  context.setEngineReason(reason);
  context.setBusy(context.t('切换 WebCodecs…'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'preparing',
    percent: 0,
    processedFrames: undefined,
    totalFrames: undefined,
    detail: context.t('本机渲染失败：{reason}，已切换 WebCodecs', { reason }),
  } : current);
}

function browserResult(context: VideoExportContext, path: string, sizeBytes: number, engine: ExportEngineInfo) {
  const { state, resolution, fps } = context.options;
  const dimensions = browserScaledExportDimensions(state, resolution);
  return {
    path,
    sizeBytes,
    durationSeconds: timelineDuration(state) / state.fps,
    width: dimensions.width,
    height: dimensions.height,
    fps,
    sourceStartSeconds: 0,
    encoder: engine,
  } satisfies ExportJobResult;
}

async function verifyBrowserResult(
  context: VideoExportContext,
  blob: Blob,
  filename: string,
  engine: ExportEngineInfo,
): Promise<void> {
  if (!context.autoQaEnabled) return;
  let path: string | null = null;
  try {
    const staged = await stageBrowserExport(blob, filename);
    path = staged.path;
    await context.verifyCompletedExport(browserResult(context, path, staged.sizeBytes, engine));
  } catch (error) {
    context.setQa({ status: 'error', attempts: 0, message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (path) await removeStagedBrowserExport(path);
  }
}

async function saveBrowserResult(
  context: VideoExportContext,
  attempt: Extract<BrowserExportAttempt, { status: 'rendered' }>,
  engine: ExportEngineInfo,
  startedAt: number,
): Promise<void> {
  const { base, codec, state, resolution } = context.options;
  const filename = `${base}.${codec === 'vp8' ? 'webm' : 'mp4'}`;
  await verifyBrowserResult(context, attempt.blob, filename, engine);
  context.setBusy(context.t('正在保存…'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'downloading',
    percent: 99,
    outputSize: attempt.blob.size,
    detail: context.t('正在写入所选位置'),
  } : current);
  await writeBlobToDestination(context.destination, filename, attempt.blob);
  const dimensions = browserScaledExportDimensions(state, resolution);
  recordExportPerformance(engine, {
    width: dimensions.width,
    height: dimensions.height,
    frames: Math.max(1, Math.round(timelineDuration(state) * context.options.fps / state.fps)),
    elapsedMs: performance.now() - startedAt,
  });
  void recordExport({ name: filename, format: 'video', codec, sizeBytes: attempt.blob.size, createdAt: Date.now() });
}

async function runBrowserRoute(
  context: VideoExportContext,
  controller: AbortController,
  engine: ExportEngineInfo,
): Promise<BrowserExportAttempt> {
  const attempt = await renderTimelineInBrowser(browserOptions(context, controller.signal));
  if (attempt.status === 'rendered') {
    context.setRenderEngine('browser');
    context.setEngineInfo(engine);
  }
  return attempt;
}

async function runBrowserThenServer(
  context: VideoExportContext,
  controller: AbortController,
  plan: ExportRoutePlan,
): Promise<void> {
  const startedAt = performance.now();
  let attempt: BrowserExportAttempt;
  try {
    attempt = await runBrowserRoute(context, controller, plan.browserEngine);
  } catch (error) {
    if (isAbortError(error)) throw error;
    switchToServer(context, plan.serverEngine, error instanceof Error ? error.message : '浏览器快导失败');
    await context.exportServerVideo(controller.signal);
    return;
  }
  if (attempt.status === 'rendered') {
    await saveBrowserResult(context, attempt, plan.browserEngine, startedAt);
    return;
  }
  switchToServer(context, plan.serverEngine, attempt.reason);
  await context.exportServerVideo(controller.signal);
}

async function runServerThenBrowser(
  context: VideoExportContext,
  controller: AbortController,
  plan: ExportRoutePlan,
): Promise<void> {
  try {
    await context.exportServerVideo(controller.signal);
    return;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!isServerRenderError(error) || plan.browser.status !== 'supported') throw error;
    const reason = error.message || '本机渲染失败';
    switchToBrowser(context, plan.browserEngine, reason);
  }
  const startedAt = performance.now();
  const attempt = await runBrowserRoute(context, controller, plan.browserEngine);
  if (attempt.status !== 'rendered') throw new Error(attempt.reason);
  await saveBrowserResult(context, attempt, plan.browserEngine, startedAt);
}

async function exportVideo(context: VideoExportContext): Promise<void> {
  const controller = new AbortController();
  context.browserAbortRef.current = controller;
  context.setRenderEngine('checking');
  context.setEngineInfo(null);
  context.setEngineReason(null);
  try {
    const options = browserOptions(context, controller.signal);
    const plan = await planVideoExportRoute(options);
    controller.signal.throwIfAborted();
    setPlannedRoute(context, plan);
    if (plan.route === 'browser') await runBrowserThenServer(context, controller, plan);
    else await runServerThenBrowser(context, controller, plan);
  } finally {
    if (context.browserAbortRef.current === controller) context.browserAbortRef.current = null;
  }
}

export function createVideoExporter(context: VideoExportContext) {
  return () => exportVideo(context);
}
