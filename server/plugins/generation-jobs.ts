import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { ResultDownloadError } from './result-download.ts';
import type { H264EncoderProfile } from '../media-acceleration.ts';

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type GenerationRetryClass = 'none' | 'provider-retryable' | 'provider-terminal' | 'download-retryable' | 'restart-recoverable';
export type GenerationCleanupPolicy = 'server-export';

export interface GenerationResult {
  assetId: string;
  kind: 'audio' | 'video' | 'image';
  name: string;
  path: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Offset of a ranged export within the source timeline. */
  sourceStartSeconds?: number;
  sizeBytes?: number;
  codec?: string;
  encoder?: H264EncoderProfile;
  encoderFallbackReason?: string;
}

export class IncompleteGenerationResultError extends Error {
  readonly code = 'generation_result_incomplete';
  readonly retryable = true;
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`generation result checkpoint is incomplete (${actual}/${expected})`);
    this.name = 'IncompleteGenerationResultError';
    this.expected = expected;
    this.actual = actual;
  }
}

export function mergeGenerationResultUrls(
  stored: readonly string[],
  incoming: readonly string[],
): string[] {
  return [...new Set([...stored, ...incoming].filter((url) => Boolean(url)))];
}

export function setGenerationResultUrlAt(
  stored: readonly string[],
  resultIndex: number,
  url: string,
): string[] {
  if (!Number.isSafeInteger(resultIndex) || resultIndex < 0 || resultIndex > stored.length || !url) {
    throw new Error('generation result URL checkpoint index is invalid');
  }
  const next = [...stored];
  next[resultIndex] = url;
  return next;
}

export function requireGenerationResultUrls(urls: readonly string[], expected: number): string[] {
  const merged = mergeGenerationResultUrls([], urls);
  if (merged.length < expected) throw new IncompleteGenerationResultError(expected, merged.length);
  return merged.slice(0, expected);
}

export interface GenerationResultCheckpoint {
  urls: string[];
  complete: boolean;
}

export function generationResultCheckpoint(
  stored: readonly string[],
  expected: number,
  providerTaskId?: string,
): GenerationResultCheckpoint {
  const urls = mergeGenerationResultUrls([], stored);
  if (urls.length > 0 && urls.length < expected && !providerTaskId) {
    throw new IncompleteGenerationResultError(expected, urls.length);
  }
  return {
    urls: urls.slice(0, expected),
    complete: urls.length >= expected,
  };
}

export interface GenerationOperationTimestamps {
  createdAt: number;
  submittedAt: number;
  acceptedAt?: number;
  startedAt?: number;
  succeededAt?: number;
  failedAt?: number;
  updatedAt: number;
}

interface AcceptanceWaiter {
  promise: Promise<GenerationAcceptance>;
  resolve: (acceptance: GenerationAcceptance) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface GenerationJob {
  id: string;
  status: GenerationJobStatus;
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  params: Record<string, unknown>;
  submitArgs?: Record<string, unknown>;
  toolName?: string;
  label?: string;
  provider?: string;
  providerTaskId?: string;
  sourceRevisions?: string[];
  resultUrls?: string[];
  expectedResultCount?: number;
  retryClass: GenerationRetryClass;
  timestamps: GenerationOperationTimestamps;
  createdAt: number;
  updatedAt: number;
  result?: GenerationResult;
  results?: GenerationResult[];
  error?: string;
  code?: string;
  retryable?: boolean;
  pendingDownloadUrl?: string;
  resumeDownload?: () => Promise<GenerationResult | GenerationResult[]>;
  resumeDownloadUrl?: string;
  cleanupResult?: (result: GenerationResult) => Promise<void> | void;
  cleanupPolicy?: string;
  retentionMs: number;
  expiryTimer?: NodeJS.Timeout;
  acceptance?: AcceptanceWaiter;
  restored?: boolean;
  resuming?: boolean;
}

export interface GenerationJobSnapshot {
  id: string;
  operationId: string;
  status: GenerationJobStatus;
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  params: Record<string, unknown>;
  submitArgs?: Record<string, unknown>;
  toolName?: string;
  label?: string;
  provider?: string;
  providerTaskId?: string;
  sourceRevisions?: string[];
  resultUrls?: string[];
  expectedResultCount?: number;
  retryClass: GenerationRetryClass;
  timestamps: GenerationOperationTimestamps;
  createdAt: number;
  updatedAt: number;
  result?: GenerationResult;
  results?: GenerationResult[];
  error?: string;
  code?: string;
  retryable?: boolean;
  cleanupPolicy?: string;
  pendingDownloadUrl?: string;
}

export interface GenerationJobProgress {
  progress?: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
}

export type UpdateGenerationJob = (progress: GenerationJobProgress) => Promise<void>;
export type RegisterGenerationDownload = (
  url: string,
  resume: () => Promise<GenerationResult | GenerationResult[]>,
  resultIndex?: number,
) => Promise<void>;
export type RegisterGenerationProviderTask = (provider: string, providerTaskId: string) => Promise<void>;
export type GenerationJobTask = (
  operationId: string,
  update: UpdateGenerationJob,
  registerDownload: RegisterGenerationDownload,
  registerProviderTask: RegisterGenerationProviderTask,
) => Promise<GenerationResult | GenerationResult[]>;

export interface GenerationJobOptions {
  operationId?: string;
  provider?: string;
  toolName?: string;
  label?: string;
  submitArgs?: Record<string, unknown>;
  sourceRevisions?: string[];
  expectedResultCount?: number;
  acquire?: () => Promise<() => void>;
  cleanupResult?: (result: GenerationResult) => Promise<void> | void;
  cleanupPolicy?: GenerationCleanupPolicy;
  retentionMs?: number;
  onSettled?: (jobId: string) => void;
}

export interface GenerationJobSubmission {
  operationId: string;
  jobId: string;
  status: 'queued';
}

export interface GenerationAcceptance extends GenerationJobSubmission {
  provider?: string;
  providerTaskId?: string;
  acceptedAt: number;
  sourceRevisions?: string[];
}

export type GenerationJobResumer = (
  snapshot: GenerationJobSnapshot,

  update: UpdateGenerationJob,
  registerDownload: RegisterGenerationDownload,
  registerProviderTask: RegisterGenerationProviderTask,
) => Promise<GenerationResult | GenerationResult[]>;

export type GenerationCleanupPolicyHandler = (result: GenerationResult) => Promise<void> | void;

const jobs = new Map<string, GenerationJob>();
const resumers = new Map<string, GenerationJobResumer>();
const cleanupPolicyHandlers = new Map<string, GenerationCleanupPolicyHandler>();
const TERMINAL = new Set<GenerationJobStatus>(['succeeded', 'failed']);
const MAX_JOB_AGE_MS = 60 * 60_000;
const STORE_PATH = process.env.OPENCHATCUT_GENERATION_JOB_STORE
  ?? join(homedir(), '.openchatcut', 'generation-operations-v1.json');
let loadPromise: Promise<void> | undefined;
let persistenceQueue: Promise<void> = Promise.resolve();

function resumerKey(toolName?: string, provider?: string): string {
  return `${toolName ?? ''}:${provider ?? ''}`;
}

export function registerGenerationJobResumer(toolName: string, provider: string, resumer: GenerationJobResumer): void {
  resumers.set(resumerKey(toolName, provider), resumer);
}

export function registerGenerationCleanupPolicy(
  policy: GenerationCleanupPolicy,
  handler: GenerationCleanupPolicyHandler,
): void {
  cleanupPolicyHandlers.set(policy, handler);
}

function snapshotOf(job: GenerationJob): GenerationJobSnapshot {
  return {
    id: job.id,
    operationId: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    processedFrames: job.processedFrames,
    totalFrames: job.totalFrames,
    params: job.params,
    submitArgs: job.submitArgs,
    toolName: job.toolName,
    label: job.label,
    provider: job.provider,
    providerTaskId: job.providerTaskId,
    sourceRevisions: job.sourceRevisions,
    resultUrls: job.resultUrls,
    expectedResultCount: job.expectedResultCount,
    retryClass: job.retryClass,
    timestamps: job.timestamps,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    results: job.results,
    error: job.error,
    code: job.code,
    retryable: job.retryable,
    cleanupPolicy: job.cleanupPolicy,
    pendingDownloadUrl: job.pendingDownloadUrl,
  };
}

function acceptanceOf(job: GenerationJob): GenerationAcceptance {
  return {
    operationId: job.id,
    jobId: job.id,
    status: 'queued',
    provider: job.provider,
    providerTaskId: job.providerTaskId,
    acceptedAt: job.timestamps.acceptedAt ?? job.updatedAt,
    sourceRevisions: job.sourceRevisions,
  };
}

function makeAcceptanceWaiter(): AcceptanceWaiter {
  let resolvePromise!: (acceptance: GenerationAcceptance) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<GenerationAcceptance>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Some non-provider jobs never await acceptance; mark rejection as observed.
  void promise.catch(() => undefined);
  return {
    promise,
    settled: false,
    resolve(acceptance) {
      if (this.settled) return;
      this.settled = true;
      resolvePromise(acceptance);
    },
    reject(error) {
      if (this.settled) return;
      this.settled = true;
      rejectPromise(error);
    },
  };
}

function persistedRows(): GenerationJobSnapshot[] {
  return [...jobs.values()].map(snapshotOf);
}

function persistJobs(): Promise<void> {
  const write = persistenceQueue.catch(() => undefined).then(async () => {
    await mkdir(dirname(STORE_PATH), { recursive: true });
    const temporary = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, jobs: persistedRows() }), 'utf8');
    await rename(temporary, STORE_PATH);
  });
  persistenceQueue = write.then(() => undefined, () => undefined);
  return write;
}

function normalizePersistedJob(value: unknown): GenerationJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<GenerationJobSnapshot>;
  if (typeof row.id !== 'string'
    || (row.status !== 'queued' && row.status !== 'running' && row.status !== 'succeeded' && row.status !== 'failed')
    || typeof row.progress !== 'number'
    || !row.params || typeof row.params !== 'object' || Array.isArray(row.params)
    || typeof row.createdAt !== 'number'
    || typeof row.updatedAt !== 'number') return null;
  const timestamps = row.timestamps && typeof row.timestamps === 'object' && !Array.isArray(row.timestamps)
    ? row.timestamps as GenerationOperationTimestamps
    : { createdAt: row.createdAt, submittedAt: row.createdAt, updatedAt: row.updatedAt };
  const restored = !TERMINAL.has(row.status);
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    phase: restored ? 'recovering' : row.phase,
    processedFrames: row.processedFrames,
    totalFrames: row.totalFrames,
    params: row.params as Record<string, unknown>,
    submitArgs: row.submitArgs,
    toolName: row.toolName,
    label: row.label,
    provider: row.provider,
    providerTaskId: row.providerTaskId,
    sourceRevisions: row.sourceRevisions,
    resultUrls: mergeGenerationResultUrls([], Array.isArray(row.resultUrls) ? row.resultUrls : []),
    expectedResultCount: Number.isSafeInteger(row.expectedResultCount) && Number(row.expectedResultCount) > 0
      ? Number(row.expectedResultCount)
      : undefined,
    retryClass: restored ? 'restart-recoverable' : row.retryClass ?? 'none',
    timestamps,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    result: row.result,
    results: row.results,
    error: row.error,
    code: row.code,
    retryable: row.retryable,
    cleanupPolicy: typeof row.cleanupPolicy === 'string' ? row.cleanupPolicy : undefined,
    pendingDownloadUrl: row.pendingDownloadUrl,
    retentionMs: MAX_JOB_AGE_MS,
    acceptance: makeAcceptanceWaiter(),
    restored,
  };
}

async function loadPersistedJobs(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, 'utf8')) as { version?: unknown; jobs?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return;
    for (const value of parsed.jobs) {
      const job = normalizePersistedJob(value);
      if (!job || jobs.has(job.id)) continue;
      jobs.set(job.id, job);
      if (job.timestamps.acceptedAt) job.acceptance?.resolve(acceptanceOf(job));
      if (TERMINAL.has(job.status)) scheduleExpiry(job);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function initializeGenerationJobs(): Promise<void> {
  if (!loadPromise) loadPromise = loadPersistedJobs().then(resumeRestoredJobs);
  return loadPromise;
}

function normalizeRetentionMs(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : MAX_JOB_AGE_MS;
}

function scheduleExpiry(job: GenerationJob): void {
  if (!TERMINAL.has(job.status)) return;
  clearTimeout(job.expiryTimer);
  const remaining = Math.max(0, job.retentionMs - (Date.now() - job.updatedAt));
  job.expiryTimer = setTimeout(() => { void evictTerminalJob(job.id); }, remaining);
  job.expiryTimer.unref?.();
}

async function evictTerminalJob(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job || !TERMINAL.has(job.status)) return false;
  const cleanup = job.cleanupPolicy
    ? cleanupPolicyHandlers.get(job.cleanupPolicy)
    : job.cleanupResult;
  if (job.cleanupPolicy && !cleanup) {
    console.warn(`[generation-job] refusing to evict ${jobId}: unknown cleanup policy ${job.cleanupPolicy}`);
    return false;
  }
  jobs.delete(jobId);
  clearTimeout(job.expiryTimer);
  if (job.results?.length && cleanup) {
    try {
      await Promise.all(job.results.map((result) => cleanup(result)));
    } catch (error) {
      console.warn(`[generation-job] failed to clean result for ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await persistJobs();
  return true;
}

async function cleanOldJobs(): Promise<void> {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  const expired = [...jobs.values()].filter((job) => TERMINAL.has(job.status) && job.updatedAt < cutoff);
  await Promise.all(expired.map((job) => evictTerminalJob(job.id)));
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

async function resumeRestoredJobs(): Promise<void> {
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

interface ProgressRequest {
  action?: 'params' | 'status' | 'wait' | 'resume';
  target?: string;
  jobIds?: string[] | string;
  timeoutSeconds?: number;
}

async function readJson(req: IncomingMessage): Promise<ProgressRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 100_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProgressRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseJobIds(value: ProgressRequest['jobIds']): string[] {
  const ids = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function report(job: GenerationJob, action: ProgressRequest['action']) {
  return {
    jobId: job.id,
    operationId: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    processedFrames: job.processedFrames,
    totalFrames: job.totalFrames,
    label: job.label,
    toolName: job.toolName,
    submitArgsVersion: job.submitArgs ? 1 : undefined,
    submitArgs: job.submitArgs,
    provider: job.provider,
    providerTaskId: job.providerTaskId,
    sourceRevisions: job.sourceRevisions,
    resultUrls: job.resultUrls,
    expectedResultCount: job.expectedResultCount,
    retryClass: job.retryClass,
    timestamps: job.timestamps,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(action === 'params' ? { params: job.params } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.results && job.results.length > 1 ? { results: job.results } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.code ? { code: job.code } : {}),
    ...(job.retryable !== undefined ? { retryable: job.retryable } : {}),
    ...(job.pendingDownloadUrl ? { pendingDownloadUrl: job.pendingDownloadUrl } : {}),
  };
}

const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function generationProgressPlugin(): Plugin {
  return {
    name: 'openchatcut-generation-progress',
    configureServer(server) {
      void initializeGenerationJobs().catch((error) => {
        server.config.logger.error(`[generate:progress] failed to restore operations: ${error instanceof Error ? error.message : String(error)}`);
      });
      server.middlewares.use('/generate/progress', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          await initializeGenerationJobs();
          await resumeRestoredJobs();
          const input = await readJson(req);
          if (input.target !== 'generation') throw new Error('target must be generation');
          if (!input.action || !['params', 'status', 'wait', 'resume'].includes(input.action)) throw new Error('action must be params, status, wait, or resume');
          const jobIds = parseJobIds(input.jobIds);
          if (!jobIds.length) throw new Error('jobIds is required');
          const timeoutSeconds = input.timeoutSeconds ?? 90;
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 3600) throw new Error('timeoutSeconds must be between 0 and 3600');

          if (input.action === 'wait') {
            const deadline = Date.now() + timeoutSeconds * 1000;
            while (Date.now() < deadline) {
              const known = jobIds.map((id) => jobs.get(id));
              if (known.every((job) => !job || TERMINAL.has(job.status))) break;
              await wait(250);
            }
          }
          if (input.action === 'resume') await Promise.all(jobIds.map((id) => resumeGenerationJobDownload(id)));

          const reports = jobIds.map((id) => {
            const job = jobs.get(id);
            return job ? report(job, input.action) : { jobId: id, operationId: id, status: 'not_found', error: 'generation job not found' };
          });
          sendJson(res, 200, { target: 'generation', action: input.action, reports });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:progress] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
