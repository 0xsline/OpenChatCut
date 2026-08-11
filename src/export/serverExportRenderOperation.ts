import type { ExportDestination } from './exportDestination';
import {
  exportFailureFrom,
  ExportFailureError,
  isExportFailure,
  type ExportFailure,
} from './exportFailure';
import {
  markServerExportOutputReady,
  persistServerExportJob,
  retireServerExportJob,
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

export interface ServerExportContext {
  autoQaEnabled: boolean;
  createOperationId?: () => string;
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

export type ExportFormat = 'video' | 'audio';
export type ExportCodec = 'h264' | 'vp8' | 'prores' | 'mp3';

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

function submissionBody(
  context: ServerExportContext,
  format: ExportFormat,
  codec: ExportCodec,
  operationId: string,
) {
  const { state, project, timelineId, base, resolution, fps, requestedVideoBitrate } = context.options;
  const body: Record<string, unknown> = {
    state, format, codec, name: base, operationId,
    ...(project && timelineId ? { project, timelineId } : {}),
  };
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
  operationId: string,
  signal?: AbortSignal,
) {
  const submission = await fetch('/export/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submissionBody(context, format, codec, operationId)),
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
  if (!submission.ok || !renderId || renderId !== operationId) {
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

export async function pollExport(
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

async function deleteExportJob(renderId: string): Promise<void> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`server export cleanup failed (${response.status})`);
  }
}

export async function retireAndDeleteExportJob(renderId: string): Promise<boolean> {
  if (!await retireServerExportJob(renderId)) return false;
  await deleteExportJob(renderId);
  return true;
}

export async function renderCompleted(
  context: ServerExportContext,
  format: ExportFormat,
  codec: ExportCodec,
  signal?: AbortSignal,
): Promise<{ renderId: string; completed: ExportJobResult }> {
  const renderId = context.createOperationId?.() ?? globalThis.crypto.randomUUID();
  let submissionAccepted = false;
  let outputObserved = false;
  try {
    await persistServerExportJob(recoveryRecord(context, renderId, format, codec));
    await submitExport(context, format, codec, renderId, signal);
    submissionAccepted = true;
    const completed = await pollExport(context, renderId, signal);
    outputObserved = true;
    await markServerExportOutputReady(renderId);
    return { renderId, completed };
  } catch (error) {
    if (submissionAccepted && !outputObserved) {
      await retireAndDeleteExportJob(renderId).catch(() => false);
    }
    throw error;
  }
}
