import {
  normalizeTrackedJob, resultAssetIdsOf, isRecoverableJob, resolveTrackedJob,
  type TrackedJobKind, type TrackedJob, type TrackedJobPatch, type GenerationOperationReservation, type TrackedJobResolution,
  type GenerationRetryClass, type GenerationOperationTimestamps,
} from './jobRegistryModel';
import { reconcileJobReports } from './jobRegistryReports';
export { resolveTrackedJob } from './jobRegistryModel';
export type {
  TrackedJobKind, GenerationRetryClass, GenerationOperationTimestamps, TrackedJob, TrackedJobPatch,
  GenerationOperationReservation, TrackedJobCandidate, TrackedJobResolution,
} from './jobRegistryModel';

// Durable client registry for asynchronous generation operations. The backend owns
// provider execution; this store keeps the complete, secret-free submission snapshot
// so refresh/restart recovery and explicit reruns do not have to reconstruct args.

import { normalizeStatus } from '../agent/progress/job-model';
import type { MediaAsset, TimelineState } from '../editor/types';
import {
  trackGenerationProgress,
  type GenerationJobReport,
  type GenerationJobResult,
} from '../generate/progress';
import { putMediaBlob } from './mediaBlobStore';
import { partitionRecords, withPreservedRecords } from './recordPartition';
import { kvGet as idbGet, kvSet as idbSet, resetSharedKvMemory } from './sharedKv';

const jobsKey = (projectId: string) => `jobs:${projectId}`;
const MAX_HISTORY = 80;

const projectQueues = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();

function enqueueProjectWrite<T>(projectId: string, write: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(projectId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(write);
  const settled = run.then(() => undefined, () => undefined);
  projectQueues.set(projectId, settled);
  void settled.finally(() => {
    if (projectQueues.get(projectId) === settled) projectQueues.delete(projectId);
  });
  return run;
}

function notify(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener();
}

export function subscribeTrackedJobs(projectId: string, listener: () => void): () => void {
  const projectListeners = listeners.get(projectId) ?? new Set<() => void>();
  projectListeners.add(listener);
  listeners.set(projectId, projectListeners);
  return () => {
    projectListeners.delete(listener);
    if (!projectListeners.size) listeners.delete(projectId);
  };
}

export function resetJobRegistryMemory(): void {
  projectQueues.clear();
  listeners.clear();
  resetSharedKvMemory();
}

async function readPartitionedJobs(projectId: string) {
  return partitionRecords(await idbGet<unknown>(jobsKey(projectId)), normalizeTrackedJob);
}

async function readJobs(projectId: string): Promise<TrackedJob[]> {
  return (await readPartitionedJobs(projectId)).valid;
}

export async function listTrackedJobs(projectId: string): Promise<TrackedJob[]> {
  try {
    return await readJobs(projectId);
  } catch {
    return [];
  }
}

async function writeJobs(projectId: string, jobs: TrackedJob[]): Promise<void> {
  let terminalHistory = 0;
  const retained = jobs
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((job) => {
      if (isRecoverableJob(job)) return true;
      terminalHistory += 1;
      return terminalHistory <= MAX_HISTORY;
    });
  // Re-read the opaque tail here rather than threading it through all seven
  // read-modify-write callers: entries this build cannot parse are never
  // modified by them, and dropping the tail would erase a newer build's jobs.
  const { opaque } = await readPartitionedJobs(projectId);
  await idbSet(jobsKey(projectId), withPreservedRecords(retained, opaque));
  notify(projectId);
}

export async function registerTrackedJob(input: {
  operationId?: string;
  jobId: string;
  projectId: string;
  kind?: TrackedJobKind;
  label?: string;
  status?: string;
  toolName?: string;
  submitArgs?: Record<string, unknown>;
  provider?: string;
  model?: string;
  providerTaskId?: string;
  sourceRevisions?: string[];
  resultUrls?: string[];
  retryClass?: GenerationRetryClass;
  idempotencyKey?: string;
  timestamps?: Partial<GenerationOperationTimestamps>;
  /** Legacy summary accepted only for migrating old callers. */
  params?: Record<string, unknown>;
}): Promise<TrackedJob> {
  return enqueueProjectWrite(input.projectId, async () => {
    const now = Date.now();
    const operationId = input.operationId ?? input.jobId;
    const list = await readJobs(input.projectId);
    const existing = list.find((job) => job.operationId === operationId || job.jobId === input.jobId);
    const baseTimestamps = existing?.timestamps ?? { createdAt: now, updatedAt: now };
    const timestamps: GenerationOperationTimestamps = {
      ...baseTimestamps,
      ...input.timestamps,
      createdAt: baseTimestamps.createdAt,
      updatedAt: now,
    };
    const job: TrackedJob = existing
      ? {
        ...existing,
        operationId,
        jobId: input.jobId,
        label: input.label ?? existing.label,
        status: input.status ?? existing.status,
        toolName: input.toolName ?? existing.toolName,
        submitArgsVersion: input.submitArgs ? 1 : existing.submitArgsVersion,
        submitArgs: input.submitArgs ?? existing.submitArgs,
        provider: input.provider ?? existing.provider,
        model: input.model ?? existing.model,
        providerTaskId: input.providerTaskId ?? existing.providerTaskId,
        sourceRevisions: input.sourceRevisions ?? existing.sourceRevisions,
        resultUrls: input.resultUrls ?? existing.resultUrls,
        retryClass: input.retryClass ?? existing.retryClass,
        idempotencyKey: input.idempotencyKey ?? existing.idempotencyKey,
        params: input.params ?? existing.params,
        timestamps,
        updatedAt: now,
      }
      : {
        operationId,
        jobId: input.jobId,
        projectId: input.projectId,
        kind: input.kind ?? 'generation',
        label: input.label,
        status: input.status ?? 'queued',
        toolName: input.toolName,
        submitArgsVersion: input.submitArgs ? 1 : undefined,
        submitArgs: input.submitArgs,
        provider: input.provider,
        model: input.model,
        providerTaskId: input.providerTaskId,
        sourceRevisions: input.sourceRevisions,
        resultUrls: input.resultUrls,
        retryClass: input.retryClass,
        idempotencyKey: input.idempotencyKey,
        params: input.params,
        timestamps,
        createdAt: now,
        updatedAt: now,
      };
    if (input.status === 'submitting') {
      delete job.error;
      delete job.timestamps.failedAt;
    }
    await writeJobs(input.projectId, [job, ...list.filter((item) => item !== existing)]);
    return job;
  });
}

/**
 * Atomically bind one semantic request to a durable operation before provider I/O.
 * Unknown submissions retain their operation; accepted entries hold it only for
 * the ordinary duplicate window; terminally rejected entries are released.
 */
export function reserveGenerationOperation(input: {
  projectId: string;
  idempotencyKey: string;
  toolName: 'submit_music' | 'submit_sound' | 'submit_video';
  acceptedWindowMs: number;
}): Promise<GenerationOperationReservation> {
  return enqueueProjectWrite(input.projectId, async () => {
    const now = Date.now();
    const list = await readJobs(input.projectId);
    const existing = list.find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const acceptedAt = existing.timestamps.acceptedAt;
      if (typeof acceptedAt === 'number' && now - acceptedAt <= input.acceptedWindowMs) {
        return {
          state: 'accepted',
          operationId: existing.operationId,
          jobId: existing.jobId,
          acceptedAt,
        };
      }
      if (acceptedAt === undefined && existing.retryClass !== 'provider-terminal') {
        return {
          state: 'resumable',
          operationId: existing.operationId,
          jobId: existing.jobId,
        };
      }
    }

    const operationId = crypto.randomUUID();
    const timestamps: GenerationOperationTimestamps = { createdAt: now, submittedAt: now, updatedAt: now };
    const reservation: TrackedJob = {
      operationId,
      jobId: operationId,
      projectId: input.projectId,
      kind: 'generation',
      status: 'submitting',
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      retryClass: 'none',
      timestamps,
      createdAt: now,
      updatedAt: now,
    };
    const released = existing
      ? list.map((job) => {
        if (job !== existing) return job;
        const releasedJob = { ...job };
        delete releasedJob.idempotencyKey;
        return releasedJob;
      })
      : list;
    await writeJobs(input.projectId, [reservation, ...released]);
    return { state: 'reserved', operationId, jobId: operationId };
  });
}

export async function patchTrackedJobs(
  projectId: string,
  patches: ReadonlyArray<{ operationId?: string; jobId: string; patch: TrackedJobPatch }>,
): Promise<void> {
  if (!patches.length) return;
  await enqueueProjectWrite(projectId, async () => {
    const list = await readJobs(projectId);
    const now = Date.now();
    let changed = false;
    const next = list.map((job) => {
      const update = patches.find((candidate) => (
        candidate.operationId ? candidate.operationId === job.operationId : candidate.jobId === job.jobId
      ));
      if (!update) return job;
      changed = true;
      const { releaseIdempotencyKey, ...persistedPatch } = update.patch;
      const status = persistedPatch.status ?? job.status;
      const terminalTimestamp = status === 'succeeded'
        ? { succeededAt: persistedPatch.timestamps?.succeededAt ?? now }
        : status === 'failed' || status === 'not_found'
          ? { failedAt: persistedPatch.timestamps?.failedAt ?? now }
          : {};
      const nextJob: TrackedJob = {
        ...job,
        ...persistedPatch,
        timestamps: {
          ...job.timestamps,
          ...persistedPatch.timestamps,
          ...terminalTimestamp,
          updatedAt: now,
        },
        updatedAt: now,
      };
      if (releaseIdempotencyKey) delete nextJob.idempotencyKey;
      return nextJob;
    });
    if (changed) await writeJobs(projectId, next);
  });
}

export function patchTrackedJob(projectId: string, jobId: string, patch: TrackedJobPatch): Promise<void> {
  return patchTrackedJobs(projectId, [{ jobId, patch }]);
}

export async function listOpenJobs(projectId: string): Promise<TrackedJob[]> {
  return (await listTrackedJobs(projectId)).filter(isRecoverableJob);
}

/** Mark terminal generation results consumed only after their project snapshot is durable. */
export async function acknowledgeIngestedGenerationResults(
  projectId: string,
  assets: readonly Pick<MediaAsset, 'id'>[],
): Promise<void> {
  if (!assets.length) return;
  const assetIds = new Set(assets.map((asset) => asset.id));
  await enqueueProjectWrite(projectId, async () => {
    const jobs = await readJobs(projectId);
    const now = Date.now();
    let changed = false;
    const next = jobs.map((job) => {
      const resultAssetIds = resultAssetIdsOf(job);
      if (job.resultIngestedAt !== undefined
        || !resultAssetIds.length
        || !resultAssetIds.every((id) => assetIds.has(id))) return job;
      changed = true;
      return { ...job, resultIngestedAt: now, updatedAt: now };
    });
    if (changed) await writeJobs(projectId, next);
  });
}

export async function resolveTrackedJobForProject(projectId: string, query: string): Promise<TrackedJobResolution> {
  return resolveTrackedJob(await listTrackedJobs(projectId), query);
}

/** Fetch a same-origin media URL into the blob cache (best-effort). */
function mediaAssetFromResult(result: GenerationJobResult, fps: number): MediaAsset | null {
  if (!result.assetId || !result.name || !result.path || !result.kind
    || typeof result.durationSeconds !== 'number' || result.durationSeconds <= 0) return null;
  return {
    id: result.assetId,
    name: result.name,
    kind: result.kind,
    src: result.path,
    durationInFrames: Math.max(1, Math.round(result.durationSeconds * fps)),
    width: result.width,
    height: result.height,
  };
}

export async function cacheMediaFromUrl(src: string, name?: string): Promise<void> {
  if (!src.startsWith('/media/uploads/')) return;
  try {
    const response = await fetch(src, { cache: 'no-store' });
    if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) return;
    const blob = await response.blob();
    await putMediaBlob(src, blob, {
      name: name ?? src.split('/').pop() ?? 'file',
      mime: blob.type || undefined,
    });
  } catch {
    /* best-effort local cache */
  }
}

/** Apply one progress response with one read/write, including jobs learned after refresh. */
export async function applyGenerationJobReports(projectId: string, reports: readonly GenerationJobReport[]): Promise<void> {
  if (!reports.length) return;
  await enqueueProjectWrite(projectId, async () => {
    const list = await readJobs(projectId);
    await writeJobs(projectId, reconcileJobReports(projectId, list, reports, Date.now()));
  });
}

/** Poll open jobs after refresh and ingest successful results exactly once. */
export async function resumeOpenGenerationJobs(
  projectId: string,
  opts: {
    getState: () => TimelineState;
    onAsset: (asset: MediaAsset) => void;
    timeoutSeconds?: number;
  },
): Promise<{ open: number; completed: number; failed: number; notFound: number }> {
  const open = (await listOpenJobs(projectId)).filter((job) => job.kind === 'generation');
  if (!open.length) return { open: 0, completed: 0, failed: 0, notFound: 0 };

  const completed = new Set<string>();
  const failed = new Set<string>();
  const notFound = new Set<string>();
  const ingestedAssets = new Set<string>();
  const pending = new Map(open.map((job) => [job.jobId, job]));
  const currentState = opts.getState();
  const existingAssets = new Set((currentState.assets ?? []).map((asset) => asset.id));
  for (const job of open) {
    if (normalizeStatus(job.status) !== 'complete' || !job.resultSnapshots?.length) continue;
    const assets = job.resultSnapshots
      .map((result) => mediaAssetFromResult(result, currentState.fps))
      .filter((asset): asset is MediaAsset => asset !== null);
    const expectedIds = resultAssetIdsOf(job);
    if (!expectedIds.length || !expectedIds.every((id) => assets.some((asset) => asset.id === id))) continue;
    for (const asset of assets) {
      if (!existingAssets.has(asset.id)) {
        opts.onAsset(asset);
        existingAssets.add(asset.id);
      }
      ingestedAssets.add(asset.id);
      void cacheMediaFromUrl(asset.src, asset.name);
    }
    completed.add(job.jobId);
    pending.delete(job.jobId);
  }
  const deadline = Date.now() + (opts.timeoutSeconds ?? 120) * 1000;
  let resumeAttempt = open.some((job) => job.retryClass === 'download-retryable'
    || job.retryClass === 'provider-retryable'
    || job.retryClass === 'restart-recoverable');
  try {
    while (pending.size && Date.now() <= deadline) {
      const remainingSeconds = Math.max(0, (deadline - Date.now()) / 1000);
      const result = await trackGenerationProgress({
        action: resumeAttempt ? 'resume' : 'wait',
        jobIds: [...pending.keys()],
        timeoutSeconds: Math.min(2, remainingSeconds),
      }, opts.getState());
      resumeAttempt = false;
      await applyGenerationJobReports(projectId, result.reports);
      let onlyProvisionalMisses = true;
      for (const report of result.reports) {
        const canonical = normalizeStatus(report.status);
        const intent = pending.get(report.jobId);
        if (canonical === 'not_found' && intent?.status === 'submitting') {
          notFound.add(report.jobId);
          continue;
        }
        onlyProvisionalMisses = false;
        notFound.delete(report.jobId);
        if (canonical === 'failed') {
          failed.add(report.jobId);
          pending.delete(report.jobId);
        } else if (canonical === 'complete') {
          completed.add(report.jobId);
          pending.delete(report.jobId);
        }
      }
      for (const asset of result.completedAssets) {
        if (ingestedAssets.has(asset.id)) continue;
        ingestedAssets.add(asset.id);
        opts.onAsset(asset);
        void cacheMediaFromUrl(asset.src, asset.name);
      }
      if (onlyProvisionalMisses && pending.size && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
  } catch {
    /* server unavailable: keep operations open for the next resume attempt */
  }
  return {
    open: open.length,
    completed: completed.size,
    failed: failed.size,
    notFound: notFound.size,
  };
}
