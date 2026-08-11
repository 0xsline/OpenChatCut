import { randomUUID } from 'node:crypto';
import { ResultDownloadError } from './result-download.ts';
import {
  TERMINAL,
  acceptanceOf,
  makeAcceptanceWaiter,
  mergeGenerationResultUrls,
  requireGenerationResultUrls,
  setGenerationResultUrlAt,
  snapshotOf,
} from './generation-job-types.ts';
import type {
  GenerationAcceptance,
  GenerationJob,
  GenerationJobOptions,
  GenerationJobProgress,
  GenerationJobSnapshot,
  GenerationJobSubmission,
  GenerationJobTask,
  GenerationResult,
} from './generation-job-types.ts';
import {
  cleanOldJobs,
  evictTerminalJob,
  jobs,
  loadPersistedJobs,
  normalizeRetentionMs,
  persistJobs,
  resumerKey,
  resumers,
  scheduleExpiry,
} from './generation-job-store.ts';

let loadPromise: Promise<void> | undefined;

export function initializeGenerationJobs(): Promise<void> {
  if (!loadPromise) loadPromise = loadPersistedJobs().then(resumeRestoredJobs);
  return loadPromise;
}

function applyProgress(job: GenerationJob, next: GenerationJobProgress): void {
  if (TERMINAL.has(job.status)) return;
  if (next.progress !== undefined && Number.isFinite(next.progress)) {
    job.progress = Math.max(job.progress, Math.min(99, Math.max(0, next.progress)));
  }
  if (next.phase !== undefined) job.phase = next.phase;
  if (next.totalFrames !== undefined && Number.isFinite(next.totalFrames)) job.totalFrames = Math.max(0, Math.floor(next.totalFrames));
  if (next.processedFrames !== undefined && Number.isFinite(next.processedFrames)) {
    const processed = Math.max(0, Math.floor(next.processedFrames));
    job.processedFrames = job.totalFrames === undefined ? processed : Math.min(job.totalFrames, processed);
  }
  job.updatedAt = Date.now();
  job.timestamps.updatedAt = job.updatedAt;
}


function completeGenerationJob(job: GenerationJob, returned: GenerationResult | GenerationResult[]): void {
  if (job.expectedResultCount !== undefined) {
    requireGenerationResultUrls(job.resultUrls ?? [], job.expectedResultCount);
  }
  job.results = Array.isArray(returned) ? returned : [returned];
  job.result = job.results[0];
  job.status = 'succeeded';
  job.progress = 100;
  job.phase = 'completed';
  job.error = undefined;
  job.code = undefined;
  job.retryable = undefined;
  job.pendingDownloadUrl = undefined;
  job.resumeDownload = undefined;
  job.resumeDownloadUrl = undefined;
  job.retryClass = 'none';
  job.timestamps.succeededAt = Date.now();
  if (!job.timestamps.acceptedAt) job.timestamps.acceptedAt = job.timestamps.succeededAt;
  if (job.totalFrames !== undefined) job.processedFrames = job.totalFrames;
}

function failGenerationJob(job: GenerationJob, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const rawRetryable = error && typeof error === 'object' && 'retryable' in error ? error.retryable : undefined;
  const code = rawCode === undefined ? undefined : String(rawCode);
  const retryable = typeof rawRetryable === 'boolean' ? rawRetryable : undefined;
  job.status = 'failed';
  job.error = message;
  job.code = code;
  job.retryable = retryable;
  if (error instanceof ResultDownloadError) job.pendingDownloadUrl = error.retryable ? error.url : undefined;
  else job.pendingDownloadUrl = job.resumeDownloadUrl;
  job.progress = 100;
  job.phase = 'failed';
  job.timestamps.failedAt = Date.now();
  if (job.pendingDownloadUrl) job.retryClass = 'download-retryable';
  else if (retryable === false) job.retryClass = 'provider-terminal';
  else if (retryable === true) job.retryClass = 'provider-retryable';
  else if (job.providerTaskId && !/(?:failed|cancelled|expired|invalid)/i.test(message)) job.retryClass = 'provider-retryable';
  else job.retryClass = 'provider-terminal';
}

async function runGenerationJob(job: GenerationJob, task: GenerationJobTask, options: GenerationJobOptions): Promise<void> {
  let release: (() => void) | undefined;
  try {
    release = await options.acquire?.();
    job.status = 'running';
    job.progress = Math.max(job.progress, 10);
    job.phase = 'starting';
    job.error = undefined;
    job.code = undefined;
    job.retryable = undefined;
    job.restored = false;
    job.retryClass = 'none';
    job.updatedAt = Date.now();
    job.timestamps.startedAt ??= job.updatedAt;
    job.timestamps.updatedAt = job.updatedAt;
    await persistJobs();
    const returned = await task(
      job.id,
      async (next) => {
        applyProgress(job, next);
        await persistJobs();
      },
      async (url, resume, resultIndex) => {
        job.resumeDownloadUrl = url;
        job.resumeDownload = resume;
        job.resultUrls = resultIndex === undefined
          ? mergeGenerationResultUrls(job.resultUrls ?? [], [url])
          : setGenerationResultUrlAt(job.resultUrls ?? [], resultIndex, url);
        job.timestamps.acceptedAt ??= Date.now();
        job.updatedAt = Date.now();
        job.timestamps.updatedAt = job.updatedAt;
        await persistJobs();
        job.acceptance?.resolve(acceptanceOf(job));
      },
      async (provider, providerTaskId) => {
        if (!providerTaskId.trim()) throw new Error(`${provider} did not return a provider task id`);
        job.provider = provider;
        job.providerTaskId = providerTaskId;
        job.timestamps.acceptedAt ??= Date.now();
        job.updatedAt = Date.now();
        job.timestamps.updatedAt = job.updatedAt;
        await persistJobs();
        job.acceptance?.resolve(acceptanceOf(job));
      },
    );
    completeGenerationJob(job, returned);
    job.acceptance?.resolve(acceptanceOf(job));
  } catch (error) {
    failGenerationJob(job, error);
    job.acceptance?.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    job.updatedAt = Date.now();
    job.timestamps.updatedAt = job.updatedAt;
    release?.();
    await persistJobs().catch((error) => {
      console.warn(`[generation-job] failed to persist ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    scheduleExpiry(job);
    options.onSettled?.(job.id);
    job.resuming = false;
  }
}

export async function createGenerationJob(
  params: Record<string, unknown>,
  task: GenerationJobTask,
  options: GenerationJobOptions = {},
): Promise<GenerationJobSubmission> {
  await initializeGenerationJobs();
  await cleanOldJobs();
  const id = options.operationId?.trim() || randomUUID();
  const existing = jobs.get(id);
  if (existing) return { operationId: id, jobId: id, status: 'queued' };
  const now = Date.now();
  const job: GenerationJob = {
    id,
    status: 'queued',
    progress: 0,
    phase: 'queued',
    params,
    submitArgs: options.submitArgs,
    toolName: options.toolName,
    label: options.label,
    provider: options.provider,
    sourceRevisions: options.sourceRevisions,
    expectedResultCount: Number.isSafeInteger(options.expectedResultCount) && Number(options.expectedResultCount) > 0
      ? Number(options.expectedResultCount)
      : undefined,
    retryClass: 'none',
    timestamps: { createdAt: now, submittedAt: now, updatedAt: now },
    createdAt: now,
    updatedAt: now,
    cleanupResult: options.cleanupResult,
    cleanupPolicy: options.cleanupPolicy,
    retentionMs: normalizeRetentionMs(options.retentionMs),
    acceptance: makeAcceptanceWaiter(),
  };
  jobs.set(id, job);
  try {
    await persistJobs();
  } catch (error) {
    jobs.delete(id);
    throw error;
  }
  queueMicrotask(() => {
    void runGenerationJob(job, task, options);
  });
  return { operationId: id, jobId: id, status: 'queued' };
}

export async function waitForGenerationAcceptance(operationId: string): Promise<GenerationAcceptance> {
  await initializeGenerationJobs();
  const job = jobs.get(operationId);
  if (!job) throw new Error(`generation operation not found: ${operationId}`);
  if (job.timestamps.acceptedAt) return acceptanceOf(job);
  if (job.status === 'failed') throw new Error(job.error ?? 'generation provider rejected the request');
  if (!job.acceptance) job.acceptance = makeAcceptanceWaiter();
  return job.acceptance.promise;
}

async function resumeWithRegisteredHandler(job: GenerationJob): Promise<boolean> {
  const resumer = resumers.get(resumerKey(job.toolName, job.provider));
  if (!resumer || job.resuming || !job.timestamps.acceptedAt) return false;
  job.resuming = true;
  job.status = 'queued';
  job.progress = Math.min(job.progress, 99);
  job.phase = 'recovering';
  job.retryClass = 'restart-recoverable';
  await persistJobs();
  void runGenerationJob(job, (_id, update, registerDownload, registerProviderTask) => (
    resumer(snapshotOf(job), update, registerDownload, registerProviderTask)
  ), {});
  return true;
}

function restoredFailure(job: GenerationJob, code: string, message: string): void {
  if (TERMINAL.has(job.status)) return;
  const now = Date.now();
  job.status = 'failed';
  job.progress = 100;
  job.phase = 'failed';
  job.error = message;
  job.code = code;
  job.retryable = true;
  job.retryClass = code === 'submission_unknown' ? 'provider-terminal' : 'provider-retryable';
  job.restored = false;
  job.resuming = false;
  job.updatedAt = now;
  job.timestamps.failedAt = now;
  job.timestamps.updatedAt = now;
  job.acceptance?.reject(Object.assign(new Error(message), { code, retryable: true }));
  scheduleExpiry(job);
}

export async function resumeRestoredJobs(): Promise<void> {
  const candidates = [...jobs.values()].filter((job) => (
    job.restored && !job.resuming && !TERMINAL.has(job.status)
  ));
  await Promise.all(candidates.map(async (job) => {
    if (await resumeWithRegisteredHandler(job)) return;
    const accepted = job.timestamps.acceptedAt !== undefined;
    restoredFailure(
      job,
      accepted ? 'resumer_unavailable' : 'submission_unknown',
      accepted
        ? 'Generation operation cannot be resumed after server restart because no resumer is registered; explicitly rerun the operation.'
        : 'Generation submission outcome is unknown after server restart; explicitly rerun the operation.',
    );
    await persistJobs();
  }));
}

export async function resumeGenerationJobDownload(jobId: string): Promise<boolean> {
  await initializeGenerationJobs();
  const job = jobs.get(jobId);
  if (!job || job.status !== 'failed') return false;
  if ((!job.resumeDownload || !job.pendingDownloadUrl) && await resumeWithRegisteredHandler(job)) return true;
  if (!job.resumeDownload || !job.pendingDownloadUrl) return false;
  clearTimeout(job.expiryTimer);
  job.status = 'running';
  job.progress = 99;
  job.phase = 'downloading';
  job.error = undefined;
  job.updatedAt = Date.now();
  job.timestamps.updatedAt = job.updatedAt;
  await persistJobs();
  try {
    completeGenerationJob(job, await job.resumeDownload());
    return true;
  } catch (error) {
    failGenerationJob(job, error);
    return false;
  } finally {
    job.updatedAt = Date.now();
    job.timestamps.updatedAt = job.updatedAt;
    await persistJobs();
    scheduleExpiry(job);
  }
}

export function getGenerationJobSnapshot(jobId: string): GenerationJobSnapshot | undefined {
  const job = jobs.get(jobId);
  return job ? snapshotOf(job) : undefined;
}

export function deleteGenerationJob(jobId: string): Promise<boolean> {
  return evictTerminalJob(jobId);
}
