import { recordExport } from '../persist/exportHistoryStore';
import { writeUrlToDestination, type ExportDestination } from './exportDestination';
import { recordExportPerformance } from './exportRoutePlanner';
import type {
  ExportEngineInfo,
  ExportJobResult,
  ExportJobSnapshot,
  ExportPhase,
  ExportProgress,
  RenderEngine,
  StateSetter,
  Translate,
  UseExportWorkflowOptions,
} from './exportWorkflowTypes';

interface ServerExportContext {
  autoQaEnabled: boolean;
  destination: ExportDestination;
  options: UseExportWorkflowOptions;
  setBusy: StateSetter<string | null>;
  setEngineInfo: StateSetter<ExportEngineInfo | null>;
  setEngineReason: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setRenderEngine: StateSetter<RenderEngine>;
  t: Translate;
  verifyCompletedExport: (completed: ExportJobResult) => Promise<void>;
}

type ExportFormat = 'video' | 'audio';
type ExportCodec = 'h264' | 'vp8' | 'mp3';
export class ServerRenderError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ServerRenderError';
  }
}

export function isServerRenderError(error: unknown): error is ServerRenderError {
  return error instanceof ServerRenderError;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Export cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function submissionBody(context: ServerExportContext, format: ExportFormat, codec: ExportCodec) {
  const { state, base, resolution, fps, requestedVideoBitrate } = context.options;
  const body: Record<string, unknown> = { state, format, codec, name: base };
  if (format !== 'video') return body;
  body.resolution = resolution;
  if (fps !== state.fps) body.fps = fps;
  if (requestedVideoBitrate !== undefined) body.videoBitrate = requestedVideoBitrate;
  return body;
}

async function submitExport(
  context: ServerExportContext,
  format: ExportFormat,
  codec: ExportCodec,
  signal?: AbortSignal,
) {
  const submission = await fetch('/export/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submissionBody(context, format, codec)),
    signal,
  });
  const submitted = (await submission.json().catch(() => null)) as { renderId?: string; error?: string } | null;
  if (!submission.ok || !submitted?.renderId) {
    throw new Error(submitted?.error ?? context.t('导出失败 ({status})', { status: submission.status }));
  }
  return submitted.renderId;
}

async function readSnapshot(
  renderId: string,
  t: Translate,
  signal?: AbortSignal,
): Promise<ExportJobSnapshot> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`, { signal });
  const snapshot = (await response.json().catch(() => null)) as ExportJobSnapshot | { error?: string } | null;
  if (!response.ok || !snapshot || !('status' in snapshot)) {
    const message = snapshot && 'error' in snapshot ? snapshot.error : undefined;
    throw new Error(message ?? t('无法读取导出进度 ({status})', { status: response.status }));
  }
  return snapshot;
}

function activePhase(snapshot: ExportJobSnapshot): ExportPhase {
  if (snapshot.phase === 'queued') return 'queued';
  if (snapshot.phase === 'finalizing') return 'finalizing';
  return snapshot.phase === 'rendering' ? 'rendering' : 'preparing';
}

function updateActiveProgress(context: ServerExportContext, snapshot: ExportJobSnapshot): void {
  context.setProgress((current) => current ? {
    ...current,
    phase: activePhase(snapshot),
    percent: Math.min(99, Math.max(current.percent, Math.round(snapshot.progress))),
    processedFrames: snapshot.processedFrames,
    totalFrames: snapshot.totalFrames,
  } : current);
}

function completeSnapshot(context: ServerExportContext, snapshot: ExportJobSnapshot): ExportJobResult {
  if (!snapshot.result?.path) throw new Error(context.t('导出完成，但没有可下载的文件'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'finalizing',
    percent: 99,
    processedFrames: snapshot.processedFrames,
    totalFrames: snapshot.totalFrames,
  } : current);
  return snapshot.result;
}

async function pollExport(
  context: ServerExportContext,
  renderId: string,
  signal?: AbortSignal,
): Promise<ExportJobResult> {
  while (true) {
    const snapshot = await readSnapshot(renderId, context.t, signal);
    if (snapshot.status === 'failed') {
      throw new ServerRenderError(new Error(snapshot.error ?? context.t('导出失败')));
    }
    if (snapshot.status === 'succeeded') return completeSnapshot(context, snapshot);
    updateActiveProgress(context, snapshot);
    await wait(300, signal);
  }
}

function updateActualEngine(context: ServerExportContext, completed: ExportJobResult): void {
  if (!completed.encoder) return;
  context.setEngineInfo(completed.encoder);
  if (completed.encoderFallbackReason) context.setEngineReason(completed.encoderFallbackReason);
}

async function deleteExportJob(renderId: string): Promise<void> {
  await fetch(`/export/job/${encodeURIComponent(renderId)}`, { method: 'DELETE' }).catch(() => undefined);
}

async function renderCompleted(
  context: ServerExportContext,
  format: ExportFormat,
  codec: ExportCodec,
  signal?: AbortSignal,
): Promise<{ renderId: string; completed: ExportJobResult }> {
  let renderId: string | null = null;
  try {
    renderId = await submitExport(context, format, codec, signal);
    return { renderId, completed: await pollExport(context, renderId, signal) };
  } catch (error) {
    if (renderId) await deleteExportJob(renderId);
    throw error;
  }
}
async function saveCompleted(
  context: ServerExportContext,
  format: ExportFormat,
  codec: ExportCodec,
  completed: ExportJobResult,
): Promise<void> {
  context.setBusy(context.t('正在保存…'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'downloading',
    percent: 99,
    detail: context.t('正在写入所选位置'),
  } : current);
  const ext = format === 'audio' ? 'mp3' : codec === 'vp8' ? 'webm' : 'mp4';
  const filename = completed.name ?? `${context.options.base}.${ext}`;
  await writeUrlToDestination(context.destination, filename, completed.path!);
  context.setProgress((current) => current ? { ...current, outputSize: completed.sizeBytes } : current);
  void recordExport({ name: filename, format, codec, sizeBytes: completed.sizeBytes, createdAt: Date.now() });
}

function recordServerPerformance(context: ServerExportContext, completed: ExportJobResult, startedAt: number): void {
  if (!completed.encoder || !completed.width || !completed.height) return;
  recordExportPerformance(completed.encoder, {
    width: completed.width,
    height: completed.height,
    frames: Math.max(1, Math.round((completed.durationSeconds ?? 0) * (completed.fps ?? context.options.fps))),
    elapsedMs: performance.now() - startedAt,
  });
}

async function exportMedia(
  context: ServerExportContext,
  format: ExportFormat,
  signal?: AbortSignal,
): Promise<ExportJobResult> {
  if (format === 'video') context.setRenderEngine('server');
  const codec = format === 'audio' ? 'mp3' : context.options.codec;
  const startedAt = performance.now();
  const { renderId, completed } = await renderCompleted(context, format, codec, signal);
  try {
    if (format === 'video') updateActualEngine(context, completed);
    if (format === 'video' && context.autoQaEnabled) await context.verifyCompletedExport(completed);
    await saveCompleted(context, format, codec, completed);
    if (format === 'video') recordServerPerformance(context, completed, startedAt);
    return completed;
  } finally {
    await deleteExportJob(renderId);
  }
}

export function createServerExporter(context: ServerExportContext) {
  return (format: ExportFormat, signal?: AbortSignal) => exportMedia(context, format, signal);
}
