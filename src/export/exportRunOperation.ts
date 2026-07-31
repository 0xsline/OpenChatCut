import { isAbortError } from './browserExport';
import { exportDestinationErrorMessage } from './exportDestination';
import type {
  ExportProgress,
  ExportQaUiState,
  StateSetter,
  Translate,
  UseExportWorkflowOptions,
  WorkflowOperations,
} from './exportWorkflowTypes';

interface ExportRunContext {
  busy: string | null;
  operations: WorkflowOperations;
  options: UseExportWorkflowOptions;
  prepareDestination: () => Promise<void>;
  progress: ExportProgress | null;
  setBusy: StateSetter<string | null>;
  setClock: StateSetter<number>;
  setError: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setQa: StateSetter<ExportQaUiState | null>;
  t: Translate;
}

async function executeAsyncSelected(context: ExportRunContext): Promise<void> {
  const { tab } = context.options;
  if (tab === 'video') await context.operations.exportVideo();
  else if (tab === 'audio') await context.operations.exportAudio();
  else if (tab === 'mg') await context.operations.exportMg();
  else await context.operations.exportXml();
}

function markCancelled(context: ExportRunContext): void {
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
  context.setQa(null);
  const startedAt = Date.now();
  context.setClock(startedAt);
  context.setProgress({ phase: 'preparing', percent: 0, startedAt });
  context.setBusy(context.t('准备导出…'));
  try {
    await context.prepareDestination();
    if (context.options.tab === 'subtitles') await context.operations.exportSubtitles();
    else await executeAsyncSelected(context);
    const finishedAt = Date.now();
    context.setClock(finishedAt);
    context.setProgress((current) => current ? { ...current, phase: 'completed', percent: 100, finishedAt } : current);
  } catch (reason) {
    if (isAbortError(reason)) {
      markCancelled(context);
      return;
    }
    context.setError(exportDestinationErrorMessage(reason, context.t));
    context.setProgress((current) => current ? { ...current, phase: 'failed', finishedAt: Date.now() } : current);
  } finally {
    context.setBusy(null);
  }
}

export function createExportRunner(context: ExportRunContext) {
  return () => runExport(context);
}
