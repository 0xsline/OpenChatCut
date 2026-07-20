// Client-side ASR job table for "上传即转写" (ingest 落库后自动触发转写).
// Unlike generation/render jobs (which run server-side and are polled over HTTP),
// transcription runs IN THE BROWSER via transcribePath, so its "job table" is this
// in-memory Map keyed by assetId. The agent polls it through track_progress
// target=transcription (see generate-tools.ts); the UI drag-drop path polls it via
// the onComplete callback. The transcript result is written onto the pool asset
// (MediaAsset.transcript) by the caller, so it survives reload; this Map is only the
// live/transient status while ASR is in flight.
import type { MediaAsset } from '../editor/types';
import type { TranscriptWord } from './types';
import { transcribePath } from './assemblyai';
import { isTerminal, type JobReportBase } from '../agent/progress/job-model';

export type TranscribeJobStatus = 'running' | 'done' | 'failed';

export interface TranscribeJob {
  assetId: string;
  status: TranscribeJobStatus;
  words?: TranscriptWord[];
  error?: string;
}

const jobs = new Map<string, TranscribeJob>();

const POLL_MS = 1000;
const DEFAULT_LANG = 'zh';

interface EnqueueOptions {
  languageCode?: string;
  /** Fired once on the terminal state so a real-store writer can persist the result
   *  onto the asset (MediaAsset.transcript / transcribeStatus). The agent path omits
   *  this and reads the terminal state via track_progress instead. */
  onComplete?: (job: TranscribeJob) => void;
  /**
   * Race-ahead ASR audio path (or a promise of one). When import starts extract-audio
   * right after the master lands—before video normalize—pass the promise here so
   * transcription doesn't wait for normalize or re-extract.
   */
  asrPath?: string | null | Promise<string | null | undefined>;
}

/** Should this asset auto-transcribe on ingest? Audio always; video unless finalize
 *  explicitly told us it has no audio track. Non-audio media never transcribes. */
export function shouldTranscribe(kind: MediaAsset['kind'], hasAudioTrack?: boolean): boolean {
  if (kind === 'audio') return true;
  if (kind === 'video') return hasAudioTrack !== false;
  return false;
}

/** Start ASR for an asset. Idempotent per assetId: a running or done job is never
 *  restarted (a failed one may be retried). No-op without a src. */
export function enqueueTranscription(
  asset: Pick<MediaAsset, 'id' | 'src'>,
  opts: EnqueueOptions = {},
): void {
  if (!asset.src) return;
  const prior = jobs.get(asset.id);
  if (prior && prior.status !== 'failed') return;
  jobs.set(asset.id, { assetId: asset.id, status: 'running' });
  void (async () => {
    let asrPath: string | null | undefined;
    try {
      asrPath = opts.asrPath != null ? await opts.asrPath : undefined;
    } catch {
      asrPath = undefined;
    }
    return transcribePath(asset.src, undefined, {
      languageCode: opts.languageCode ?? DEFAULT_LANG,
      asrPath: asrPath || undefined,
    });
  })()
    .then((result): TranscribeJob => ({ assetId: asset.id, status: 'done', words: result.words }))
    .catch((error: unknown): TranscribeJob => ({
      assetId: asset.id,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((job) => {
      jobs.set(asset.id, job);
      opts.onComplete?.(job);
    });
}

export function getTranscribeJob(assetId: string): TranscribeJob | undefined {
  return jobs.get(assetId);
}

/** Wait until every listed asset's in-flight ASR job settles, or timeout elapses.
 *  Assets with no live job (already persisted onto the asset, or never enqueued) are
 *  not waited on — track_progress reconciles those from the asset itself. */
export async function waitForTranscribeJobs(assetIds: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = assetIds.some((id) => {
      const job = jobs.get(id);
      return job !== undefined && !isTerminal(job.status);
    });
    if (!pending || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Test seam: reset the in-memory table (used by the check; not part of the app flow). */
export function __resetTranscribeJobs(): void {
  jobs.clear();
}

/** tool-facing status for one asset, reconciling the live job with what's already
 *  been persisted onto the asset. `assetTranscribed` = the asset already carries a
 *  non-empty transcript (job may have been cleared on reload). */
export type TranscriptionReportStatus = 'running' | 'succeeded' | 'failed' | 'not_found';

export interface TranscriptionReport extends JobReportBase<TranscriptionReportStatus> {
  assetId: string;
  wordCount?: number;
}

export function transcriptionReport(
  assetId: string,
  job: TranscribeJob | undefined,
  assetWordCount: number,
): TranscriptionReport {
  if (job?.status === 'done') return { assetId, status: 'succeeded', wordCount: job.words?.length ?? assetWordCount };
  if (job?.status === 'failed') return { assetId, status: 'failed', error: job.error };
  if (job?.status === 'running') return { assetId, status: 'running' };
  // No live job: fall back to what's persisted on the asset.
  if (assetWordCount > 0) return { assetId, status: 'succeeded', wordCount: assetWordCount };
  return { assetId, status: 'not_found' };
}
