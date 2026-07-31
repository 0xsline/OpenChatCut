import { isAbortError } from './browserExport';
import { ExportDestinationError, exportDestinationErrorMessage } from './exportDestination';
import {
  createExportFailure,
  exportFailureFrom,
  withExportFailureTarget,
  type ExportFailure,
} from './exportFailure';
import { assertExportMediaReadable } from './exportMediaPlan';
import type {
  ExportProgress,
  ExportOperationResult,
  ExportQaUiState,
  StateSetter,
  Translate,
  UseExportWorkflowOptions,
  WorkflowOperations,
} from './exportWorkflowTypes';

interface ExportRunContext {
  signal: AbortSignal;
  busy: string | null;
  operations: WorkflowOperations;
  options: UseExportWorkflowOptions;
  prepareDestination: () => Promise<void>;
  progress: ExportProgress | null;
  setBusy: StateSetter<string | null>;
  setClock: StateSetter<number>;
  setError: StateSetter<string | null>;
  setFailure: StateSetter<ExportFailure | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setQa: StateSetter<ExportQaUiState | null>;
  t: Translate;
  targetPath: string | null;
}

async function executeAsyncSelected(context: ExportRunContext): Promise<ExportOperationResult | void> {
  const { tab } = context.options;
  if (tab === 'video') return context.operations.exportVideo(context.signal);
  if (tab === 'audio') return context.operations.exportAudio(context.signal);
  if (tab === 'mg') return context.operations.exportMg(context.signal);
  return context.operations.exportXml(context.signal);
}

function markCancelled(context: ExportRunContext): void {
  const failure = createExportFailure({
    stage: 'cancel',
    code: 'export_cancelled',
    retryable: false,
    cleanupStatus: 'succeeded',
    targetPath: context.targetPath,
    message: context.t('已取消导出'),
  });
  context.setFailure(failure);
  context.setError(failure.message);
  context.setProgress((current) => current ? {
    ...current,
    phase: 'cancelled',
    finishedAt: Date.now(),
    detail: context.t('已取消导出'),
  } : current);
}

async function runExport(context: ExportRunContext): Promise<void> {
  if (context.busy) return;
  if (context.progress?.phase === 'completed') {
    context.options.onClose();
    return;
  }
  context.setError(null);
  context.setFailure(null);
  context.setQa(null);
  const startedAt = Date.now();
  context.setClock(startedAt);
  context.setProgress({ phase: 'preparing', percent: 0, startedAt });
  context.setBusy(context.t('准备导出…'));
  try {
    context.signal.throwIfAborted();
    const mediaSnapshot = context.options.project
      ? {
        ...context.options.project,
        activeTimelineId: context.options.timelineId ?? context.options.project.activeTimelineId,
      }
      : context.options.state;
    await assertExportMediaReadable(mediaSnapshot);
    context.signal.throwIfAborted();
    await context.prepareDestination();
    context.signal.throwIfAborted();
    const result = context.options.tab === 'subtitles'
      ? await context.operations.exportSubtitles(context.signal)
      : await executeAsyncSelected(context);
    if (!result?.targetCommitted) context.signal.throwIfAborted();
    const finishedAt = Date.now();
    context.setClock(finishedAt);
    context.setProgress((current) => current ? { ...current, phase: 'completed', percent: 100, finishedAt } : current);
  } catch (reason) {
    if (isAbortError(reason)) {
      markCancelled(context);
      return;
    }
    const existing = exportFailureFrom(reason);
    const message = exportDestinationErrorMessage(reason, context.t);
    const failure = existing
      ? withExportFailureTarget(existing, context.targetPath ?? existing.targetPath)
      : createExportFailure({
        stage: reason instanceof ExportDestinationError ? 'destination' : 'render',
        code: reason instanceof ExportDestinationError ? 'export_destination_failed' : 'export_failed',
        retryable: true,
        targetPath: context.targetPath,
        message,
      });
    context.setFailure(failure);
    context.setError(failure.message);
    context.setProgress((current) => current ? { ...current, phase: 'failed', finishedAt: Date.now() } : current);
  } finally {
    context.setBusy(null);
  }
}

export function createExportRunner(context: ExportRunContext) {
  return () => runExport(context);
}
