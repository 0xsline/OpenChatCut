import { recordExport } from '../persist/exportHistoryStore';
import { downloadBlob } from './exportFiles';
import type {
  ExportJobResult,
  ExportJobSnapshot,
  ExportPhase,
  StateSetter,
  ExportProgress,
  RenderEngine,
  Translate,
  UseExportWorkflowOptions,
} from './exportWorkflowTypes';

interface ServerExportContext {
  autoQaEnabled: boolean;
  options: UseExportWorkflowOptions;
  setBusy: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setRenderEngine: StateSetter<RenderEngine>;
  t: Translate;
  verifyCompletedExport: (completed: ExportJobResult) => Promise<void>;
}

type ExportFormat = 'video' | 'audio';
type ExportCodec = 'h264' | 'vp8' | 'mp3';

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function submissionBody(context: ServerExportContext, format: ExportFormat, codec: ExportCodec) {
  const { state, base, resolution, fps, requestedVideoBitrate } = context.options;
  const body: Record<string, unknown> = { state, format, codec, name: base };
  if (format !== 'video') return body;
  body.resolution = resolution;
  if (fps !== state.fps) body.fps = fps;
  if (requestedVideoBitrate !== undefined) body.videoBitrate = requestedVideoBitrate;
  return body;
}

async function submitExport(context: ServerExportContext, format: ExportFormat, codec: ExportCodec) {
  const submission = await fetch('/export/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submissionBody(context, format, codec)),
  });
  const submitted = (await submission.json().catch(() => null)) as { renderId?: string; error?: string } | null;
  if (!submission.ok || !submitted?.renderId) {
    throw new Error(submitted?.error ?? context.t('导出失败 ({status})', { status: submission.status }));
  }
  return submitted.renderId;
}

async function readSnapshot(renderId: string, t: Translate): Promise<ExportJobSnapshot> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`);
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

async function pollExport(context: ServerExportContext, renderId: string): Promise<ExportJobResult> {
  while (true) {
    const snapshot = await readSnapshot(renderId, context.t);
    if (snapshot.status === 'failed') throw new Error(snapshot.error ?? context.t('导出失败'));
    if (snapshot.status === 'succeeded') return completeSnapshot(context, snapshot);
    updateActiveProgress(context, snapshot);
    await wait(300);
  }
}

async function downloadCompleted(
  context: ServerExportContext,
  format: ExportFormat,
  codec: ExportCodec,
  renderId: string,
  completed: ExportJobResult,
): Promise<void> {
  context.setBusy(context.t('正在下载…'));
  context.setProgress((current) => current ? { ...current, phase: 'downloading', percent: 99 } : current);
  const file = await fetch(completed.path!);
  if (!file.ok) throw new Error(context.t('下载导出文件失败 ({status})', { status: file.status }));
  const blob = await file.blob();
  const ext = format === 'audio' ? 'mp3' : codec === 'vp8' ? 'webm' : 'mp4';
  const filename = completed.name ?? `${context.options.base}.${ext}`;
  downloadBlob(blob, filename);
  void fetch(`/export/job/${encodeURIComponent(renderId)}`, { method: 'DELETE' }).catch(() => {});
  context.setProgress((current) => current ? { ...current, outputSize: completed.sizeBytes ?? blob.size } : current);
  void recordExport({ name: filename, format, codec, sizeBytes: completed.sizeBytes ?? blob.size, createdAt: Date.now() });
}

async function exportMedia(context: ServerExportContext, format: ExportFormat): Promise<void> {
  if (format === 'video') context.setRenderEngine('server');
  const codec = format === 'audio' ? 'mp3' : context.options.codec;
  const renderId = await submitExport(context, format, codec);
  const completed = await pollExport(context, renderId);
  if (format === 'video' && context.autoQaEnabled) await context.verifyCompletedExport(completed);
  await downloadCompleted(context, format, codec, renderId, completed);
}

export function createServerExporter(context: ServerExportContext) {
  return (format: ExportFormat) => exportMedia(context, format);
}
