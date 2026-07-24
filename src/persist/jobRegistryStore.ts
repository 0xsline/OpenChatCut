// Client-side registry of async jobs (generation primarily). Server jobs live in
// an in-memory Map that dies on vite restart; this registry remembers jobIds so
// refresh can re-poll and still ingest completed assets into the media pool.
// Local stand-in for a durable generation_job table.

import { isTerminal, normalizeStatus } from '../agent/progress/job-model';
import type { MediaAsset } from '../editor/types';
import { trackGenerationProgress, type GenerationJobReport } from '../generate/progress';
import type { TimelineState } from '../editor/types';
import { putMediaBlob } from './mediaBlobStore';
import { kvGet as idbGet, kvSet as idbSet, resetSharedKvMemory } from './sharedKv';

const jobsKey = (projectId: string) => `jobs:${projectId}`;

export type TrackedJobKind = 'generation';

export interface TrackedJob {
  jobId: string;
  projectId: string;
  kind: TrackedJobKind;
  /** human label for UI / agent (e.g. music prompt) */
  label?: string;
  /** wire status: queued | running | succeeded | failed | not_found */
  status: string;
  params?: Record<string, unknown>;
  resultPath?: string;
  resultAssetId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export function resetJobRegistryMemory(): void {
  resetSharedKvMemory();
}

function isTrackedJob(v: unknown): v is TrackedJob {
  if (!v || typeof v !== 'object') return false;
  const j = v as Partial<TrackedJob>;
  return typeof j.jobId === 'string'
    && typeof j.projectId === 'string'
    && j.kind === 'generation'
    && typeof j.status === 'string'
    && typeof j.createdAt === 'number'
    && typeof j.updatedAt === 'number';
}

export async function listTrackedJobs(projectId: string): Promise<TrackedJob[]> {
  try {
    const raw = await idbGet<unknown>(jobsKey(projectId));
    return Array.isArray(raw) ? raw.filter(isTrackedJob) : [];
  } catch {
    return [];
  }
}

async function writeJobs(projectId: string, jobs: TrackedJob[]): Promise<void> {
  // Cap history so IDB does not grow forever (keep newest 80).
  const trimmed = jobs
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 80);
  await idbSet(jobsKey(projectId), trimmed);
}

export async function registerTrackedJob(input: {
  jobId: string;
  projectId: string;
  kind?: TrackedJobKind;
  label?: string;
  status?: string;
  params?: Record<string, unknown>;
}): Promise<TrackedJob> {
  const now = Date.now();
  const list = await listTrackedJobs(input.projectId);
  const existing = list.find((j) => j.jobId === input.jobId);
  const job: TrackedJob = existing
    ? {
      ...existing,
      label: input.label ?? existing.label,
      status: input.status ?? existing.status,
      params: input.params ?? existing.params,
      updatedAt: now,
    }
    : {
      jobId: input.jobId,
      projectId: input.projectId,
      kind: input.kind ?? 'generation',
      label: input.label,
      status: input.status ?? 'queued',
      params: input.params,
      createdAt: now,
      updatedAt: now,
    };
  const next = [job, ...list.filter((j) => j.jobId !== input.jobId)];
  try {
    await writeJobs(input.projectId, next);
  } catch {
    /* ignore */
  }
  return job;
}

export async function patchTrackedJob(
  projectId: string,
  jobId: string,
  patch: Partial<Pick<TrackedJob, 'status' | 'label' | 'resultPath' | 'resultAssetId' | 'error' | 'params'>>,
): Promise<void> {
  const list = await listTrackedJobs(projectId);
  const idx = list.findIndex((j) => j.jobId === jobId);
  if (idx < 0) return;
  const next = list.slice();
  next[idx] = { ...next[idx], ...patch, updatedAt: Date.now() };
  try {
    await writeJobs(projectId, next);
  } catch {
    /* ignore */
  }
}

export async function listOpenJobs(projectId: string): Promise<TrackedJob[]> {
  const list = await listTrackedJobs(projectId);
  return list.filter((j) => !isTerminal(j.status));
}

/** Fetch a same-origin media URL into the blob cache (best-effort). */
export async function cacheMediaFromUrl(src: string, name?: string): Promise<void> {
  if (!src.startsWith('/media/uploads/')) return;
  try {
    const res = await fetch(src, { cache: 'no-store' });
    // Vite dev fallback 200 + index.html for missing paths - don't cache HTML as media.
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return;
    const blob = await res.blob();
    await putMediaBlob(src, blob, {
      name: name ?? src.split('/').pop() ?? 'file',
      mime: blob.type || undefined,
    });
  } catch {
    /* ignore */
  }
}

function applyReportToJob(projectId: string, report: GenerationJobReport): Promise<void> {
  const status = report.status;
  const path = report.result?.path;
  const assetId = report.result?.assetId;
  return patchTrackedJob(projectId, report.jobId, {
    status,
    error: report.error,
    resultPath: path,
    resultAssetId: assetId,
  });
}

/**
 * Poll open generation jobs for a project; ingest any newly completed assets.
 * Safe to call on editor open after refresh.
 */
export async function resumeOpenGenerationJobs(
  projectId: string,
  opts: {
    getState: () => TimelineState;
    onAsset: (asset: MediaAsset) => void;
    /** wait budget for still-running server jobs (seconds) */
    timeoutSeconds?: number;
  },
): Promise<{ open: number; completed: number; failed: number; notFound: number }> {
  const open = await listOpenJobs(projectId);
  const gen = open.filter((j) => j.kind === 'generation');
  if (gen.length === 0) return { open: 0, completed: 0, failed: 0, notFound: 0 };

  let completed = 0;
  let failed = 0;
  let notFound = 0;
  try {
    const result = await trackGenerationProgress({
      action: 'wait',
      jobIds: gen.map((j) => j.jobId),
      timeoutSeconds: opts.timeoutSeconds ?? 120,
    }, opts.getState());

    for (const report of result.reports) {
      await applyReportToJob(projectId, report);
      const canon = normalizeStatus(report.status);
      if (canon === 'not_found') notFound += 1;
      else if (canon === 'failed') failed += 1;
      else if (canon === 'complete') completed += 1;
    }
    for (const asset of result.completedAssets) {
      opts.onAsset(asset);
      void cacheMediaFromUrl(asset.src, asset.name);
    }
  } catch {
    /* network / server down — leave jobs open for next attempt */
  }

  return { open: gen.length, completed, failed, notFound };
}
