// Client-side visual-analysis job table for track_progress target=visual-analysis.
// Analysis jobs run after ingest so the agent can wait before using frame tools.
// Lightweight readiness probe — contact-sheet extraction for /media/uploads.
// video, or instant succeed for images; blob placeholders stay "running" until relink.
//
// view_asset_frames / view_timeline_frames remain the actual vision path; this job only
// answers whether the asset is pre-warmed and reachable by frame tools.

import type { MediaAsset } from '../../editor/types';
import { isMediaSrcReachable } from '../../persist/mediaBlobStore';
import { isTerminal, type JobReportBase } from './job-model';

export type VisualAnalysisStatus = 'running' | 'succeeded' | 'failed' | 'not_found';

export interface VisualAnalysisJob {
  assetId: string;
  status: VisualAnalysisStatus;
  /** Sample count when a contact sheet was built, else 0 for image / probe-only. */
  sampleCount?: number;
  error?: string;
  note?: string;
}

const jobs = new Map<string, VisualAnalysisJob>();
const POLL_MS = 800;

export interface VisualAnalysisReport extends JobReportBase<VisualAnalysisStatus> {
  assetId: string;
  sampleCount?: number;
  note?: string;
}

/** Idempotent start. video → extract-frames warm; image → succeed; audio → not visual. */
export function enqueueVisualAnalysis(
  asset: Pick<MediaAsset, 'id' | 'src' | 'kind'>,
): void {
  if (!asset.src) return;
  if (asset.kind === 'audio') {
    jobs.set(asset.id, {
      assetId: asset.id,
      status: 'succeeded',
      sampleCount: 0,
      note: 'audio has no frames; visual-analysis is a no-op',
    });
    return;
  }
  const prior = jobs.get(asset.id);
  if (prior && prior.status !== 'failed') return;

  jobs.set(asset.id, { assetId: asset.id, status: 'running' });
  void runAnalysis(asset)
    .then((job) => { jobs.set(asset.id, job); })
    .catch((err: unknown) => {
      jobs.set(asset.id, {
        assetId: asset.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

async function runAnalysis(
  asset: Pick<MediaAsset, 'id' | 'src' | 'kind'>,
): Promise<VisualAnalysisJob> {
  const src = asset.src!;
  // Wait briefly if still a blob placeholder (upload in flight).
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    return {
      assetId: asset.id,
      status: 'running',
      note: 'waiting for master upload before visual analysis',
    };
  }

  if (asset.kind === 'image' || asset.kind === 'gif' || asset.kind === 'svg') {
    const ok = src.startsWith('/media/') ? await isMediaSrcReachable(src) : true;
    return {
      assetId: asset.id,
      status: ok ? 'succeeded' : 'running',
      sampleCount: ok ? 1 : 0,
      note: ok ? 'still image ready' : 'image not reachable yet',
    };
  }

  // Video: warm contact sheet via server ffmpeg when on /media/uploads.
  if (src.startsWith('/media/uploads/')) {
    try {
      const res = await fetch('/api/extract-frames', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ src, count: 4 }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          count?: number;
          frames?: unknown[];
          ok?: boolean;
        };
        const n = typeof data.count === 'number'
          ? data.count
          : Array.isArray(data.frames) ? data.frames.length : 4;
        return {
          assetId: asset.id,
          status: 'succeeded',
          sampleCount: n,
          note: 'contact-sheet warm complete; use view_asset_frames for vision',
        };
      }
      // extract may be unavailable — fall through to reachability probe
    } catch {
      /* probe path */
    }
    const ok = await isMediaSrcReachable(src);
    return {
      assetId: asset.id,
      status: ok ? 'succeeded' : 'failed',
      sampleCount: ok ? 0 : undefined,
      note: ok
        ? 'source reachable (contact-sheet warm skipped); use view_asset_frames'
        : 'source not reachable',
      error: ok ? undefined : 'media not reachable',
    };
  }

  // Remote / library video — treat as ready for frame tools that accept URL.
  return {
    assetId: asset.id,
    status: 'succeeded',
    sampleCount: 0,
    note: 'remote/library source; analyze on demand via view_asset_frames',
  };
}

/**
 * Re-enqueue after relink (blob → /media/uploads) so a stuck "running" placeholder
 * job gets a real probe. Forces restart when prior was running on blob.
 */
export function refreshVisualAnalysis(asset: Pick<MediaAsset, 'id' | 'src' | 'kind'>): void {
  const prior = jobs.get(asset.id);
  if (prior?.status === 'succeeded') return;
  if (prior?.status === 'running') jobs.delete(asset.id);
  enqueueVisualAnalysis(asset);
}

export function getVisualAnalysisJob(assetId: string): VisualAnalysisJob | undefined {
  return jobs.get(assetId);
}

export function visualAnalysisReport(
  assetId: string,
  job: VisualAnalysisJob | undefined,
): VisualAnalysisReport {
  if (!job) return { assetId, status: 'not_found' };
  return {
    assetId,
    status: job.status,
    sampleCount: job.sampleCount,
    error: job.error,
    note: job.note,
  };
}

export async function waitForVisualAnalysisJobs(
  assetIds: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Kick re-probe for jobs still "running" with no progress path
    const pending = assetIds.some((id) => {
      const job = jobs.get(id);
      return job !== undefined && !isTerminal(job.status === 'succeeded' ? 'succeeded' : job.status);
    });
    // Treat succeeded/failed/not_found as terminal; running is not.
    const still = assetIds.some((id) => {
      const job = jobs.get(id);
      if (!job) return false;
      return job.status === 'running';
    });
    if (!still || Date.now() >= deadline) return;
    void pending;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export function __resetVisualAnalysisJobs(): void {
  jobs.clear();
}
