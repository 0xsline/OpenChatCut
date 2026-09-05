import type { GenerationJobReport } from '../generate/progress';
import { resultAssetIdsOf, type TrackedJob, type TrackedJobPatch } from './jobRegistryModel';

function reportPatch(report: GenerationJobReport): TrackedJobPatch {
  const results = report.results?.length ? report.results : report.result ? [report.result] : [];
  const resultAssetIds = [...new Set(results
    .map((result) => result.assetId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const primaryResult = report.result ?? report.results?.[0];
  return {
    status: report.status,
    error: report.error,
    resultPath: primaryResult?.path,
    resultAssetId: primaryResult?.assetId,
    resultAssetIds: resultAssetIds.length ? resultAssetIds : undefined,
    resultSnapshots: results.length ? results : undefined,
    provider: report.provider,
    providerTaskId: report.providerTaskId,
    resultUrls: report.resultUrls ?? (report.pendingDownloadUrl ? [report.pendingDownloadUrl] : undefined),
    retryClass: report.retryClass,
    timestamps: report.timestamps,
  };
}

function applyReport(job: TrackedJob, report: GenerationJobReport, now: number): TrackedJob {
  // A refresh can race the original request while provider preflight is still
  // materializing a source slice. Keep the awaited local intent open until
  // the stable operation id appears in the server journal.
  if (report.status === 'not_found'
    && job.status === 'submitting'
    && now - (job.timestamps.submittedAt ?? job.createdAt) < 5 * 60_000) {
    return job;
  }
  const patch = reportPatch(report);
  const resultSetChanged = patch.resultAssetIds !== undefined
    && (patch.resultAssetIds.length !== resultAssetIdsOf(job).length
      || patch.resultAssetIds.some((id) => !resultAssetIdsOf(job).includes(id)));
  const terminalTimestamp = report.status === 'succeeded'
    ? { succeededAt: patch.timestamps?.succeededAt ?? now }
    : report.status === 'failed' || report.status === 'not_found'
      ? { failedAt: patch.timestamps?.failedAt ?? now }
      : {};
  return {
    ...job,
    ...patch,
    ...(resultSetChanged ? { resultIngestedAt: undefined } : {}),
    toolName: report.toolName ?? job.toolName,
    submitArgsVersion: report.submitArgsVersion ?? job.submitArgsVersion,
    submitArgs: report.submitArgs ?? job.submitArgs,
    model: report.model ?? job.model,
    sourceRevisions: report.sourceRevisions ?? job.sourceRevisions,
    label: report.label ?? job.label,
    timestamps: {
      ...job.timestamps,
      ...patch.timestamps,
      ...terminalTimestamp,
      updatedAt: now,
    },
    updatedAt: now,
  };
}

function jobFromReport(projectId: string, report: GenerationJobReport, now: number): TrackedJob {
  const createdAt = report.timestamps?.createdAt ?? now;
  const patch = reportPatch(report);
  return {
    operationId: report.operationId ?? report.jobId,
    jobId: report.jobId,
    projectId,
    kind: 'generation',
    label: report.label,
    status: report.status,
    submitArgsVersion: report.submitArgsVersion,
    submitArgs: report.submitArgs,
    toolName: report.toolName,
    provider: report.provider,
    model: report.model,
    providerTaskId: report.providerTaskId,
    sourceRevisions: report.sourceRevisions,
    resultUrls: patch.resultUrls,
    resultPath: patch.resultPath,
    resultAssetId: patch.resultAssetId,
    resultAssetIds: patch.resultAssetIds,
    resultSnapshots: patch.resultSnapshots,
    retryClass: report.retryClass,
    error: report.error,
    params: report.params,
    timestamps: {
      createdAt,
      ...report.timestamps,
      updatedAt: now,
    },
    createdAt,
    updatedAt: now,
  };
}

export function reconcileJobReports(
  projectId: string, list: readonly TrackedJob[], reports: readonly GenerationJobReport[], now: number,
): TrackedJob[] {
  const remaining = new Set(reports);
  const next = list.map((job) => {
    const report = reports.find((candidate) => (
      candidate.operationId ? candidate.operationId === job.operationId : candidate.jobId === job.jobId
    ));
    if (!report) return job;
    remaining.delete(report);
    return applyReport(job, report, now);
  });
  for (const report of remaining) next.push(jobFromReport(projectId, report, now));
  return next;
}
