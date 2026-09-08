import { isTerminal, normalizeStatus } from '../agent/progress/job-model';
import type { GenerationJobResult } from '../generate/progress';

export type TrackedJobKind = 'generation';
export type GenerationRetryClass =
  | 'none'
  | 'provider-retryable'
  | 'provider-terminal'
  | 'download-retryable'
  | 'restart-recoverable'
  | 'legacy-unknown';

export interface GenerationOperationTimestamps {
  createdAt: number;
  submittedAt?: number;
  acceptedAt?: number;
  startedAt?: number;
  succeededAt?: number;
  failedAt?: number;
  updatedAt: number;
}

export interface TrackedJob {
  /** Stable OpenChatCut operation identity. Legacy rows normalize this from jobId. */
  operationId: string;
  /** Backend polling handle. Kept separately from a provider task id. */
  jobId: string;
  projectId: string;
  kind: TrackedJobKind;
  label?: string;
  status: string;
  /** Versioned full tool args. This is the only rerunnable snapshot. */
  submitArgsVersion?: 1;
  submitArgs?: Record<string, unknown>;
  toolName?: string;
  provider?: string;
  model?: string;
  providerTaskId?: string;
  sourceRevisions?: string[];
  /** Canonical semantic request key held from pre-submit reservation through the accepted duplicate window. */
  idempotencyKey?: string;
  resultUrls?: string[];
  resultPath?: string;
  resultAssetId?: string;
  /** Every generated asset returned by this operation, including multi-result jobs. */
  resultAssetIds?: string[];
  /** Set only after a project snapshot containing every result asset is durably saved. */
  resultIngestedAt?: number;
  /** Durable provider result metadata used when the server journal expires before ingestion. */
  resultSnapshots?: GenerationJobResult[];
  retryClass?: GenerationRetryClass;
  error?: string;
  timestamps: GenerationOperationTimestamps;
  /** Pre-v1 summary only. Retained for display/backward compatibility, never rerun. */
  params?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TrackedJobPatch extends Partial<Pick<TrackedJob,
  | 'status'
  | 'label'
  | 'resultPath'
  | 'resultAssetId'
  | 'resultAssetIds'
  | 'error'
  | 'params'
  | 'provider'
  | 'model'
  | 'resultSnapshots'
  | 'providerTaskId'
  | 'resultUrls'
  | 'retryClass'
  | 'sourceRevisions'
>> {
  timestamps?: Partial<GenerationOperationTimestamps>;
  /** Definitive provider rejection only: atomically release the semantic operation reservation. */
  releaseIdempotencyKey?: boolean;
}

export function normalizeTrackedJob(value: unknown): TrackedJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stored = value as Partial<TrackedJob>;
  if (typeof stored.jobId !== 'string'
    || typeof stored.projectId !== 'string'
    || stored.kind !== 'generation'
    || typeof stored.status !== 'string'
    || typeof stored.createdAt !== 'number'
    || typeof stored.updatedAt !== 'number') return null;
  const operationId = typeof stored.operationId === 'string' && stored.operationId ? stored.operationId : stored.jobId;
  const rawTimestamps = stored.timestamps && typeof stored.timestamps === 'object' && !Array.isArray(stored.timestamps)
    ? stored.timestamps as Partial<GenerationOperationTimestamps>
    : {};
  const submitArgs = stored.submitArgs && typeof stored.submitArgs === 'object' && !Array.isArray(stored.submitArgs)
    ? stored.submitArgs as Record<string, unknown>
    : undefined;
  const resultAssetIds = Array.isArray(stored.resultAssetIds)
    ? [...new Set(stored.resultAssetIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : typeof stored.resultAssetId === 'string' && stored.resultAssetId
      ? [stored.resultAssetId]
      : undefined;
  const resultSnapshots = Array.isArray(stored.resultSnapshots)
    ? stored.resultSnapshots.filter((result): result is GenerationJobResult => (
      !!result && typeof result === 'object' && typeof result.assetId === 'string'
    ))
    : undefined;
  return {
    ...(stored as TrackedJob),
    operationId,
    submitArgsVersion: stored.submitArgsVersion === 1 ? 1 : undefined,
    submitArgs,
    resultAssetIds: resultAssetIds ?? resultSnapshots
      ?.map((result) => result.assetId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
    resultSnapshots,
    timestamps: {
      createdAt: typeof rawTimestamps.createdAt === 'number' ? rawTimestamps.createdAt : stored.createdAt,
      submittedAt: typeof rawTimestamps.submittedAt === 'number' ? rawTimestamps.submittedAt : undefined,
      acceptedAt: typeof rawTimestamps.acceptedAt === 'number' ? rawTimestamps.acceptedAt : undefined,
      startedAt: typeof rawTimestamps.startedAt === 'number' ? rawTimestamps.startedAt : undefined,
      succeededAt: typeof rawTimestamps.succeededAt === 'number' ? rawTimestamps.succeededAt : undefined,
      failedAt: typeof rawTimestamps.failedAt === 'number' ? rawTimestamps.failedAt : undefined,
      updatedAt: typeof rawTimestamps.updatedAt === 'number' ? rawTimestamps.updatedAt : stored.updatedAt,
    },
  };
}

export function resultAssetIdsOf(job: TrackedJob): string[] {
  return job.resultAssetIds?.length
    ? job.resultAssetIds
    : job.resultAssetId
      ? [job.resultAssetId]
      : [];
}

export function isRecoverableJob(job: TrackedJob): boolean {
  const resultPendingIngestion = normalizeStatus(job.status) === 'complete'
    && resultAssetIdsOf(job).length > 0
    && job.resultIngestedAt === undefined;
  return !isTerminal(job.status)
    || resultPendingIngestion
    || job.retryClass === 'download-retryable'
    || job.retryClass === 'provider-retryable'
    || job.retryClass === 'restart-recoverable';
}

export type GenerationOperationReservation =
  | { state: 'reserved'; operationId: string; jobId: string }
  | { state: 'resumable'; operationId: string; jobId: string }
  | { state: 'accepted'; operationId: string; jobId: string; acceptedAt: number };

export interface TrackedJobCandidate {
  operationId: string;
  distinguishingId: string;
  label?: string;
}

export type TrackedJobResolution =
  | { ok: true; job: TrackedJob }
  | { ok: false; code: 'not_found' | 'ambiguous'; message: string; candidates?: TrackedJobCandidate[] };

function shortestUniquePrefix(id: string, ids: readonly string[]): string {
  for (let length = 1; length <= id.length; length += 1) {
    const prefix = id.slice(0, length);
    if (ids.filter((candidate) => candidate.startsWith(prefix)).length === 1) return prefix;
  }
  return id;
}

/** Resolve exact ids first. Prefixes are accepted only when they identify one row. */
export function resolveTrackedJob(jobs: readonly TrackedJob[], query: string): TrackedJobResolution {
  const id = query.trim();
  const exact = jobs.filter((job) => job.operationId === id || job.jobId === id);
  if (exact.length === 1) return { ok: true, job: exact[0] };
  const matches = jobs.filter((job) => job.operationId.startsWith(id) || job.jobId.startsWith(id));
  if (!matches.length) return { ok: false, code: 'not_found', message: `generation operation not found: ${id}` };
  if (matches.length === 1) return { ok: true, job: matches[0] };
  const ids = matches.map((job) => job.operationId);
  const candidates = matches.map((job) => ({
    operationId: job.operationId,
    distinguishingId: shortestUniquePrefix(job.operationId, ids),
    label: job.label,
  }));
  return {
    ok: false,
    code: 'ambiguous',
    message: `generation operation id is ambiguous: ${id}. Use one of: ${candidates.map((candidate) => candidate.distinguishingId).join(', ')}`,
    candidates,
  };
}
