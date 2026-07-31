import { timelineDuration } from '../editor/types';
import { recordExport } from '../persist/exportHistoryStore';
import {
  exportVideoWithFallback,
  renderTimelineInBrowser,
  type BrowserExportAttempt,
  type BrowserExportOptions,
} from './browserExport';
import { downloadBlob } from './exportFiles';
import type {
  BrowserAbortRef,
  ExportProgress,
  RenderEngine,
  StateSetter,
  Translate,
  UseExportWorkflowOptions,
} from './exportWorkflowTypes';

interface VideoExportContext {
  autoQaEnabled: boolean;
  browserAbortRef: BrowserAbortRef;
  exportServerVideo: () => Promise<void>;
  options: UseExportWorkflowOptions;
  setBusy: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setRenderEngine: StateSetter<RenderEngine>;
  t: Translate;
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

async function renderBrowser(context: VideoExportContext, controller: AbortController) {
  const { state, codec, resolution, fps, requestedVideoBitrate } = context.options;
  const attempt = await renderTimelineInBrowser({
    state,
    codec,
    resolution,
    fps,
    videoBitrate: requestedVideoBitrate,
    signal: controller.signal,
    onProgress: browserProgress(context),
  });
  if (attempt.status === 'rendered') context.setRenderEngine('browser');
  return attempt;
}

function fallbackToServer(context: VideoExportContext, reason: string): void {
  context.setRenderEngine('server');
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

function downloadBrowserResult(
  context: VideoExportContext,
  attempt: Extract<BrowserExportAttempt, { status: 'rendered' }>,
): void {
  const { base, codec } = context.options;
  context.setBusy(context.t('正在下载…'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'downloading',
    percent: 99,
    outputSize: attempt.blob.size,
  } : current);
  const filename = `${base}.${codec === 'vp8' ? 'webm' : 'mp4'}`;
  downloadBlob(attempt.blob, filename);
  void recordExport({ name: filename, format: 'video', codec, sizeBytes: attempt.blob.size, createdAt: Date.now() });
}

async function exportVideo(context: VideoExportContext): Promise<void> {
  if (context.autoQaEnabled) {
    context.setRenderEngine('server');
    await context.exportServerVideo();
    return;
  }
  const controller = new AbortController();
  context.browserAbortRef.current = controller;
  context.setRenderEngine('checking');
  try {
    const result = await exportVideoWithFallback({
      browser: () => renderBrowser(context, controller),
      server: context.exportServerVideo,
      onFallback: (reason) => fallbackToServer(context, reason),
    });
    if (result.engine === 'server') return;
    downloadBrowserResult(context, result.attempt);
  } finally {
    if (context.browserAbortRef.current === controller) context.browserAbortRef.current = null;
  }
}

export function createVideoExporter(context: VideoExportContext) {
  return () => exportVideo(context);
}
