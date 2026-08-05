import type { BackgroundExportJobSetters, ExportJobStore } from './backgroundExportStore';
import { isAbortError } from './browserExport';
import { recordExport } from '../persist/exportHistoryStore';
import {
  ensureExportDestinationWritable,
  ExportDestinationError,
  exportDestinationErrorMessage,
  exportDestinationFilename,
  exportHistoryDestinationId,
  writeUrlToDestination,
  type ExportDestination,
} from './exportDestination';
import { recordExportPerformance } from './exportRoutePlanner';
import {
  createExportFailure,
  exportFailureFrom,
  ExportFailureError,
  isExportFailure,
  type ExportFailure,
} from './exportFailure';
import { createExportVerifier } from './exportQaOperation';
import {
  deleteServerExportJob as deleteServerExportRecovery,
  listServerExportJobs,
  markServerExportTargetCommitted,
  persistServerExportJob,
  type PersistedServerExportJob,
} from './serverExportRecovery';
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
  targetPath?: string | null;
  beginTargetCommit(): void;
  endTargetCommit(): void;
  markTargetCommitted(): void;
  setBusy: StateSetter<string | null>;
  setEngineInfo: StateSetter<ExportEngineInfo | null>;
  setEngineReason: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setRenderEngine: StateSetter<RenderEngine>;
  t: Translate;
  verifyCompletedExport: (completed: ExportJobResult, signal?: AbortSignal) => Promise<void>;
}

type ExportFormat = 'video' | 'audio';
type ExportCodec = 'h264' | 'vp8' | 'prores' | 'mp3';
function recoveryRecord(
  context: ServerExportContext,
  renderId: string,
  format: ExportFormat,
  codec: ExportCodec,
): PersistedServerExportJob {
  const projectId = context.options.projectId;
  const ext = format === 'audio' ? 'mp3' : codec === 'vp8' ? 'webm' : codec === 'prores' ? 'mov' : 'mp4';
  const now = Date.now();
  return {
    version: 1,
    renderId,
    projectId,
    label: `${context.options.base}.${ext}`,
    targetPath: context.targetPath ?? null,
    createdAt: now,
    updatedAt: now,
    format,
    codec,
    base: context.options.base,
    fps: context.options.fps,
    state: context.options.state,
    destination: context.destination,
    autoQaEnabled: context.autoQaEnabled,
    stage: 'polling',
  };
}

export class ServerRenderError extends Error {
  readonly failure?: ExportFailure;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ServerRenderError';
    const failure = exportFailureFrom(cause);
    if (failure) this.failure = failure;
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
  const { state, project, timelineId, base, resolution, fps, requestedVideoBitrate } = context.options;
  const body: Record<string, unknown> = { state, format, codec, name: base, ...(project && timelineId ? { project, timelineId } : {}) };
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
  const submitted: unknown = await submission.json().catch(() => null);
  if (submitted && typeof submitted === 'object' && 'failure' in submitted && isExportFailure(submitted.failure)) {
    throw new ExportFailureError(submitted.failure);
  }
  const renderId = submitted && typeof submitted === 'object' && 'renderId' in submitted
    && typeof submitted.renderId === 'string'
    ? submitted.renderId
    : null;
  if (!submission.ok || !renderId) {
    const error = submitted && typeof submitted === 'object' && 'error' in submitted
      && typeof submitted.error === 'string'
      ? submitted.error
      : context.t('导出失败 ({status})', { status: submission.status });
    throw new Error(error);
  }
  return renderId;
}

async function readSnapshot(
  renderId: string,
  t: Translate,
  signal?: AbortSignal,
): Promise<ExportJobSnapshot> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`, { signal });
  const snapshot: unknown = await response.json().catch(() => null);
  const validSnapshot = snapshot !== null && typeof snapshot === 'object'
    && 'status' in snapshot
    && (snapshot.status === 'queued' || snapshot.status === 'running'
      || snapshot.status === 'succeeded' || snapshot.status === 'failed')
    && 'progress' in snapshot && typeof snapshot.progress === 'number';
  if ((!response.ok || !validSnapshot)
    && snapshot && typeof snapshot === 'object'
    && 'failure' in snapshot && isExportFailure(snapshot.failure)) {
    throw new ExportFailureError(snapshot.failure);
  }
  if (!response.ok || !validSnapshot) {
    const message = snapshot && typeof snapshot === 'object' && 'error' in snapshot
      && typeof snapshot.error === 'string' ? snapshot.error : undefined;
    throw new Error(message ?? t('无法读取导出进度 ({status})', { status: response.status }));
  }
  return snapshot as ExportJobSnapshot;
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
      const cause = snapshot.failure
        ? new ExportFailureError(snapshot.failure)
        : new Error(snapshot.error ?? context.t('导出失败'));
      throw new ServerRenderError(cause);
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
    const recovery = recoveryRecord(context, renderId, format, codec);
    if (recovery) await persistServerExportJob(recovery);
    return { renderId, completed: await pollExport(context, renderId, signal) };
  } catch (error) {
    if (renderId) {
      await deleteExportJob(renderId);
      await deleteServerExportRecovery(renderId).catch(() => undefined);
    }
    throw error;
  }
}
async function saveCompleted(
  context: ServerExportContext,
  format: ExportFormat,
  codec: ExportCodec,
  completed: ExportJobResult,
  renderId: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  context.setBusy(context.t('正在保存…'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'downloading',
    percent: 99,
    detail: context.t('正在写入所选位置'),
  } : current);
  signal?.throwIfAborted();
  const ext = format === 'audio' ? 'mp3' : codec === 'vp8' ? 'webm' : 'mp4';
  const filename = completed.name ?? `${context.options.base}.${ext}`;
  context.beginTargetCommit();
  try {
    await writeUrlToDestination(context.destination, filename, completed.path!, signal);
    await markServerExportTargetCommitted(renderId);
    context.markTargetCommitted();
  } catch (error) {
    context.endTargetCommit();
    throw error;
  }
  context.setProgress((current) => current ? { ...current, outputSize: completed.sizeBytes } : current);
  const destinationId = exportHistoryDestinationId(context.destination);
  const historyName = exportDestinationFilename(context.destination, filename);
  void recordExport({
    name: historyName,
    format,
    codec,
    sizeBytes: completed.sizeBytes,
    createdAt: Date.now(),
    ...(destinationId ? { destinationId } : {}),
  });
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
    signal?.throwIfAborted();
    if (format === 'video' && context.autoQaEnabled) {
      await context.verifyCompletedExport(completed, signal);
      signal?.throwIfAborted();
    }
    await saveCompleted(context, format, codec, completed, renderId, signal);
    if (format === 'video') recordServerPerformance(context, completed, startedAt);
    return completed;
  } finally {
    await deleteExportJob(renderId);
    await deleteServerExportRecovery(renderId).catch(() => undefined);
  }
}

export function createServerExporter(context: ServerExportContext) {
  return (format: ExportFormat, signal?: AbortSignal) => exportMedia(context, format, signal);
}

interface ResumePersistedServerExportsOptions {
  exportJobs: ExportJobStore;
  projectId: string;
  t: Translate;
}

const recoveringServerExports = new Set<string>();

function recoveredContext(
  record: PersistedServerExportJob,
  setters: BackgroundExportJobSetters,
  t: Translate,
): ServerExportContext {
  const options: UseExportWorkflowOptions = {
    state: record.state,
    projectName: 'Recovered export',
    projectId: record.projectId,
    base: record.base,
    tab: record.format,
    codec: record.codec === 'vp8' ? 'vp8' : 'h264',
    resolution: '1080p',
    fps: record.fps,
    subtitleFormat: 'srt',
    subtitleCaptions: null,
    nleFormat: 'fcp_xml',
    includeMg: false,
    mgItems: [],
    onClose: () => undefined,
  };
  return {
    autoQaEnabled: record.autoQaEnabled,
    destination: record.destination,
    options,
    targetPath: record.targetPath,
    t,
    verifyCompletedExport: createExportVerifier({
      fps: record.fps,
      state: record.state,
      t,
      ...setters,
    }),
    ...setters,
  };
}

async function runRecoveredServerExport(
  record: PersistedServerExportJob,
  setters: BackgroundExportJobSetters,
  signal: AbortSignal,
  t: Translate,
): Promise<void> {
  const context = recoveredContext(record, setters, t);
  const startedAt = performance.now();
  setters.setClock(Date.now());
  setters.setBusy(t('正在恢复导出…'));
  setters.setRenderEngine(record.format === 'video' ? 'server' : 'idle');
  try {
    if (record.stage === 'target-committed') {
      setters.markTargetCommitted();
    } else {
      signal.throwIfAborted();
      await ensureExportDestinationWritable(record.destination);
      signal.throwIfAborted();
      const completed = await pollExport(context, record.renderId, signal);
      if (record.format === 'video') updateActualEngine(context, completed);
      signal.throwIfAborted();
      if (record.format === 'video' && record.autoQaEnabled) {
        await context.verifyCompletedExport(completed, signal);
        signal.throwIfAborted();
      }
      await saveCompleted(context, record.format, record.codec, completed, record.renderId, signal);
      if (record.format === 'video') recordServerPerformance(context, completed, startedAt);
    }
    const finishedAt = Date.now();
    setters.setClock(finishedAt);
    setters.setProgress((current) => current ? {
      ...current,
      phase: 'completed',
      percent: 100,
      finishedAt,
    } : current);
  } catch (reason) {
    const cancelled = isAbortError(reason);
    const existing = exportFailureFrom(reason);
    const message = exportDestinationErrorMessage(reason, t);
    const failure = existing ?? createExportFailure({
      stage: cancelled ? 'cancel' : reason instanceof ExportDestinationError ? 'destination' : 'render',
      code: cancelled ? 'export_cancelled'
        : reason instanceof ExportDestinationError ? 'export_destination_failed' : 'export_failed',
      retryable: !cancelled,
      targetPath: record.targetPath,
      message: cancelled ? t('已取消导出') : message,
    });
    setters.setFailure(failure);
    setters.setError(failure.message);
    setters.setProgress((current) => current ? {
      ...current,
      phase: cancelled ? 'cancelled' : 'failed',
      finishedAt: Date.now(),
    } : current);
  } finally {
    await deleteExportJob(record.renderId);
    await deleteServerExportRecovery(record.renderId).catch(() => undefined);
    setters.setBusy(null);
    recoveringServerExports.delete(record.renderId);
  }
}

/** Reattach this editor to durable server renders accepted before a browser refresh. */
export async function resumePersistedServerExports({
  exportJobs,
  projectId,
  t,
}: ResumePersistedServerExportsOptions): Promise<void> {
  const records = await listServerExportJobs(projectId);
  for (const record of records) {
    if (recoveringServerExports.has(record.renderId)) continue;
    const recovered = exportJobs.recover({
      id: `server-export-${record.renderId}`,
      label: record.label,
      targetPath: record.targetPath,
      createdAt: record.createdAt,
      execute: ({ signal, setters }) => runRecoveredServerExport(record, setters, signal, t),
    });
    if (recovered) recoveringServerExports.add(record.renderId);
  }
}
