import type { TimelineState } from '../editor/types';
import { runExportQa, type ExportQaRequest } from './autoQa';
import {
  captionLayoutQaIssues,
  exportQaExpectations,
  mergeExportQaIssues,
  timelineCutTimesSeconds,
} from './quality';
import type {
  ExportJobResult,
  StateSetter,
  ExportProgress,
  ExportQaUiState,
  Translate,
} from './exportWorkflowTypes';

interface ExportQaContext {
  fps: number;
  setBusy: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setQa: StateSetter<ExportQaUiState | null>;
  state: TimelineState;
  t: Translate;
}

function qaRequest(state: TimelineState, completed: ExportJobResult, fps: number): ExportQaRequest {
  const baseline = exportQaExpectations(state);
  const expected = {
    ...baseline,
    durationSeconds: completed.durationSeconds ?? baseline.durationSeconds,
    width: completed.width ?? baseline.width,
    height: completed.height ?? baseline.height,
    fps: completed.fps ?? fps,
  };
  const sourceStart = completed.sourceStartSeconds ?? 0;
  const cutTimesSeconds = timelineCutTimesSeconds(state, 24)
    .map((seconds) => Number((seconds - sourceStart).toFixed(4)))
    .filter((seconds) => seconds > 0 && seconds < expected.durationSeconds)
    .slice(0, 8);
  return { src: completed.path!, ...expected, cutTimesSeconds, maxEvidenceCuts: 8 };
}

function beginQa(context: ExportQaContext): void {
  context.setBusy(context.t('正在检查导出质量…'));
  context.setQa({ status: 'running', attempts: 0 });
  context.setProgress((current) => current ? {
    ...current,
    phase: 'verifying',
    percent: 99,
    detail: context.t('检查画面、声音、剪辑点和字幕安全区，失败时最多自动复检 3 轮'),
  } : current);
}

async function verifyCompletedExport(context: ExportQaContext, completed: ExportJobResult): Promise<void> {
  if (!completed.path) return;
  beginQa(context);
  try {
    const result = await runExportQa(qaRequest(context.state, completed, context.fps));
    const report = mergeExportQaIssues(result.response.report, captionLayoutQaIssues(context.state));
    const mediaType = result.response.evidence?.mediaType ?? 'image/jpeg';
    const base64 = result.response.evidence?.base64;
    context.setQa({
      status: report.issues.length ? 'issues' : 'passed',
      attempts: result.attempts,
      report,
      ...(base64 ? { evidenceUrl: `data:${mediaType};base64,${base64}` } : {}),
    });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    context.setQa({ status: 'error', attempts: 0, message });
  }
}

export function createExportVerifier(context: ExportQaContext) {
  return (completed: ExportJobResult) => verifyCompletedExport(context, completed);
}
