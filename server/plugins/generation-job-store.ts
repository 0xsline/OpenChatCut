import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runtimeProfile } from '../runtime-profile.ts';
import {
  initializeSqliteProjectStore,
  registerStorageMigrationBarrier,
  sqliteReadEntry,
  sqliteStoreEnabled,
  sqliteWriteEntry,
} from '../storage/sqlite-store.ts';
import { GENERATION_JOBS_KV_KEY } from '../storage/sqlite-migration.ts';
import {
  TERMINAL,
  acceptanceOf,
  makeAcceptanceWaiter,
  mergeGenerationResultUrls,
  snapshotOf,
} from './generation-job-types.ts';
import type {
  GenerationCleanupPolicy,
  GenerationCleanupPolicyHandler,
  GenerationJob,
  GenerationJobResumer,
  GenerationJobSnapshot,
  GenerationOperationTimestamps,
  GenerationRetentionGuard,
} from './generation-job-types.ts';

export const jobs = new Map<string, GenerationJob>();
export const resumers = new Map<string, GenerationJobResumer>();
const cleanupPolicyHandlers = new Map<string, GenerationCleanupPolicyHandler>();
const retentionGuards = new Map<string, GenerationRetentionGuard>();
const MAX_JOB_AGE_MS = 60 * 60_000;
const STORE_PATH = runtimeProfile().generationJobStore;
let persistenceHydrated = false;
let persistenceQueue: Promise<void> = Promise.resolve();
let persistenceMigrationGate: Promise<void> | null = null;
registerStorageMigrationBarrier(async () => {
  // Before hydration, only drain existing writes: writing the empty in-memory
  // map would destroy the configured legacy ledger before it is imported.
  // Once hydrated, persist the current in-memory snapshot as the migration
  // boundary, then wait until no later queued write exists.
  if (persistenceHydrated) await persistJobs();
  let observed: Promise<void>;
  do {
    observed = persistenceQueue;
    await observed;
  } while (observed !== persistenceQueue);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  persistenceMigrationGate = gate;
  return () => {
    if (persistenceMigrationGate === gate) persistenceMigrationGate = null;
    release();
  };
});

export function resumerKey(toolName?: string, provider?: string): string {
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

export function registerGenerationRetentionGuard(
  policy: GenerationCleanupPolicy,
  guard: GenerationRetentionGuard,
): void {
  retentionGuards.set(policy, guard);
}


function persistedRows(): GenerationJobSnapshot[] {
  return [...jobs.values()].map(snapshotOf);
}

export function persistJobs(): Promise<void> {
  const write = persistenceQueue.catch(() => undefined).then(async () => {
    const migrationGate = persistenceMigrationGate;
    if (migrationGate) await migrationGate;
    if (sqliteStoreEnabled()) {
      // SQLite backend: the whole jobs snapshot lives under one kv key.
      await sqliteWriteEntry(GENERATION_JOBS_KV_KEY, { version: 1, jobs: persistedRows() });
      return;
    }
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

export async function loadPersistedJobs(): Promise<void> {
  await initializeSqliteProjectStore();
  let parsed: { version?: unknown; jobs?: unknown } | null = null;
  if (sqliteStoreEnabled()) {
    const row = await sqliteReadEntry(GENERATION_JOBS_KV_KEY);
    if (row.found && row.value && typeof row.value === 'object') {
      parsed = row.value as { version?: unknown; jobs?: unknown };
    }
  } else {
    try {
      parsed = JSON.parse(await readFile(STORE_PATH, 'utf8')) as { version?: unknown; jobs?: unknown };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
    persistenceHydrated = true;
    return;
  }
  for (const value of parsed.jobs) {
    const job = normalizePersistedJob(value);
    if (!job || jobs.has(job.id)) continue;
    jobs.set(job.id, job);
    if (job.timestamps.acceptedAt) job.acceptance?.resolve(acceptanceOf(job));
    if (TERMINAL.has(job.status)) scheduleExpiry(job);
  }
  persistenceHydrated = true;
}

export function normalizeRetentionMs(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : MAX_JOB_AGE_MS;
}

export function scheduleExpiry(job: GenerationJob, retryMs?: number): void {
  if (!TERMINAL.has(job.status)) return;
  clearTimeout(job.expiryTimer);
  const remaining = retryMs ?? Math.max(0, job.retentionMs - (Date.now() - job.updatedAt));
  job.expiryTimer = setTimeout(() => { void evictTerminalJob(job.id, true); }, remaining);
  job.expiryTimer.unref?.();
}

async function retentionBlocked(job: GenerationJob): Promise<boolean> {
  const guard = job.cleanupPolicy ? retentionGuards.get(job.cleanupPolicy) : undefined;
  if (!guard) return false;
  try {
    return await guard(job.id);
  } catch (error) {
    console.warn(`[generation-job] retention guard failed for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

export async function evictTerminalJob(jobId: string, retentionExpiry = false): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job || !TERMINAL.has(job.status)) return false;
  const cleanup = job.cleanupPolicy
    ? cleanupPolicyHandlers.get(job.cleanupPolicy)
    : job.cleanupResult;
  if (job.cleanupPolicy && !cleanup) {
    console.warn(`[generation-job] refusing to evict ${jobId}: unknown cleanup policy ${job.cleanupPolicy}`);
    return false;
  }
  if (await retentionBlocked(job)) {
    if (retentionExpiry) scheduleExpiry(job, 60_000);
    return false;
  }
  if (job.results?.length && cleanup) {
    try {
      await Promise.all(job.results.map((result) => cleanup(result)));
    } catch (error) {
      console.warn(`[generation-job] failed to clean result for ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  jobs.delete(jobId);
  clearTimeout(job.expiryTimer);
  try {
    await persistJobs();
  } catch (error) {
    jobs.set(jobId, job);
    scheduleExpiry(job, 60_000);
    throw error;
  }
  return true;
}

export async function cleanOldJobs(): Promise<void> {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  const expired = [...jobs.values()].filter((job) => TERMINAL.has(job.status) && job.updatedAt < cutoff);
  await Promise.all(expired.map((job) => evictTerminalJob(job.id, true)));
}
