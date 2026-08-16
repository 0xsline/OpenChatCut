// Client-side ASR coordinator. Live status remains in memory for
// track_progress; durable checkpoints retain provider identity and source
// revision. AssemblyAI additionally resumes upload and provider job ids.
import type { MediaAsset } from '../editor/types';
import {
  sourceRevisionOf,
  type MediaSourceDescriptor,
} from '../editor/mediaSourceRevision';
import {
  hasOperationalTranscript,
  type TranscriptWord,
  type TranscriptionProviderId,
} from './types';
import {
  preferredTranscriptionDiarization,
  preferredTranscriptionLanguage,
  preferredTranscriptionProvider,
  transcribePathResumable,
  type AssemblyAiProviderStatus,
} from './provider';
import {
  loadTranscriptionCheckpoint,
  saveTranscriptionCheckpoint,
  type TranscriptionCheckpoint,
  type TranscriptionProviderStatus,
} from '../persist/transcriptionJobStore';
import { isTerminal, type JobReportBase } from '../agent/progress/job-model';

export type TranscribeJobStatus = 'running' | 'done' | 'failed';

export interface TranscribeJob {
  projectId: string;
  assetId: string;
  status: TranscribeJobStatus;
  /** Monotonic identity for this in-memory attempt. */
  generation: number;
  sourceRevision: string;
  providerJobId?: string;
  providerStatus?: TranscriptionProviderStatus;
  retryAttempts?: number;
  stale?: boolean;
  words?: TranscriptWord[];
  error?: string;
}

const jobs = new Map<string, TranscribeJob>();
const jobKey = (projectId: string, assetId: string): string => (
  `${encodeURIComponent(projectId)}:${encodeURIComponent(assetId)}`
);
let nextGeneration = 0;

function isCurrentGeneration(
  projectId: string,
  assetId: string,
  sourceRevision: string,
  generation: number,
): boolean {
  const current = jobs.get(jobKey(projectId, assetId));
  return current?.generation === generation && current.sourceRevision === sourceRevision;
}

const POLL_MS = 1000;

interface EnqueueOptions {
  languageCode?: string;
  /** Fired once on the terminal state so a real-store writer can persist the result
   *  onto the asset (MediaAsset.transcript / transcribeStatus). The agent path omits
   *  this and reads the terminal state via track_progress instead. */
  onComplete?: (job: TranscribeJob) => void;
  /** Live source lookup used as the final stale-result commit guard. */
  getCurrentAsset?: () => (MediaSourceDescriptor & { id: string }) | null | undefined;
  /**
   * Race-ahead ASR audio path (or a promise of one). When import starts extract-audio
   * right after the master lands—before video normalize—pass the promise here so
   * transcription doesn't wait for normalize or re-extract.
   */
  asrPath?: string | null | Promise<string | null | undefined>;
}

function storedProviderStatus(status: AssemblyAiProviderStatus): TranscriptionProviderStatus {
  if (status === 'uploaded') return 'uploaded';
  if (status === 'submitted') return 'submitted';
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'failed';
  return 'processing';
}

/** Should this asset auto-transcribe on ingest? Audio always; video unless finalize
 *  explicitly told us it has no audio track. Non-audio media never transcribes. */
export function shouldTranscribe(kind: MediaAsset['kind'], hasAudioTrack?: boolean): boolean {
  if (kind === 'audio') return true;
  if (kind === 'video') return hasAudioTrack !== false;
  return false;
}
function checkpointForAttempt(
  key: { projectId: string; assetId: string; sourceRevision: string },
  provider: TranscriptionProviderId,
  existing: TranscriptionCheckpoint | null,
  explicitLanguage: string | undefined,
  preferredLanguage: string,
  preferredDiarize: boolean,
  now: number,
): TranscriptionCheckpoint {
  const resumable = existing?.provider === provider ? existing : null;
  return {
    ...key,
    provider,
    providerJobId: resumable?.providerJobId,
    providerStatus: resumable?.providerStatus === 'completed'
      ? 'completed'
      : resumable?.providerStatus ?? 'preparing',
    uploadUrl: resumable?.uploadUrl,
    languageCode: explicitLanguage ?? resumable?.languageCode ?? preferredLanguage,
    diarize: resumable?.diarize ?? preferredDiarize,
    retry: {
      attempts: (resumable?.retry.attempts ?? 0) + 1,
      lastAttemptAt: now,
    },
    createdAt: resumable?.createdAt ?? now,
    updatedAt: now,
  };
}


/** Start or resume ASR for one exact project, asset, and source revision. */
export function enqueueTranscription(
  projectId: string,
  asset: MediaSourceDescriptor & { id: string },
  opts: EnqueueOptions = {},
): void {
  if (!projectId || !asset.src) return;
  const sourceRevision = sourceRevisionOf(asset);
  const logicalJobKey = jobKey(projectId, asset.id);
  const prior = jobs.get(logicalJobKey);
  if (prior && prior.sourceRevision === sourceRevision && prior.status !== 'failed') return;

  const provider = preferredTranscriptionProvider();
  const languageCode = preferredTranscriptionLanguage();
  const diarize = preferredTranscriptionDiarization();
  const generation = ++nextGeneration;
  jobs.set(logicalJobKey, {
    projectId,
    assetId: asset.id,
    generation,
    sourceRevision,
    status: 'running',
  });
  const sourceIsCurrent = (): boolean => {
    if (!opts.getCurrentAsset) return true;
    const current = opts.getCurrentAsset();
    return Boolean(
      current
      && current.id === asset.id
      && sourceRevisionOf(current) === sourceRevision
    );
  };

  void (async (): Promise<TranscribeJob | null> => {
    const key = { projectId, assetId: asset.id, sourceRevision };
    let checkpoint: TranscriptionCheckpoint | undefined;
    try {
      const now = Date.now();
      const existing = await loadTranscriptionCheckpoint(key);
      if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return null;

      checkpoint = checkpointForAttempt(
        key,
        provider,
        existing,
        opts.languageCode,
        languageCode,
        diarize,
        now,
      );
      await saveTranscriptionCheckpoint(checkpoint);
      if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return null;
      jobs.set(logicalJobKey, {
        projectId,
        assetId: asset.id,
        generation,
        sourceRevision,
        status: 'running',
        providerJobId: checkpoint.providerJobId,
        providerStatus: checkpoint.providerStatus,
        retryAttempts: checkpoint.retry.attempts,
      });

      let asrPath: string | null | undefined;
      try {
        asrPath = opts.asrPath != null ? await opts.asrPath : undefined;
      } catch {
        asrPath = undefined;
      }
      if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return null;

      const result = await transcribePathResumable(
        asset.src,
        {
          uploadUrl: checkpoint.uploadUrl,
          providerJobId: checkpoint.providerJobId,
        },
        async (provider) => {
          if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return;
          const nextCheckpoint: TranscriptionCheckpoint = {
            ...checkpoint!,
            uploadUrl: provider.uploadUrl ?? checkpoint!.uploadUrl,
            providerJobId: provider.providerJobId ?? checkpoint!.providerJobId,
            providerStatus: storedProviderStatus(provider.providerStatus ?? 'processing'),
            updatedAt: Date.now(),
          };
          await saveTranscriptionCheckpoint(nextCheckpoint);
          if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return;
          checkpoint = nextCheckpoint;
          jobs.set(logicalJobKey, {
            projectId,
            assetId: asset.id,
            generation,
            sourceRevision,
            status: 'running',
            providerJobId: checkpoint.providerJobId,
            providerStatus: checkpoint.providerStatus,
            retryAttempts: checkpoint.retry.attempts,
          });
        },
        undefined,
        {
          languageCode: checkpoint.languageCode,
          diarize: checkpoint.diarize ?? diarize,
          asrPath: asrPath || undefined,
        },
        provider,
      );

      if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return null;
      if (!sourceIsCurrent()) {
        const staleCheckpoint: TranscriptionCheckpoint = {
          ...checkpoint,
          providerStatus: 'stale',
          updatedAt: Date.now(),
        };
        await saveTranscriptionCheckpoint(staleCheckpoint);
        if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return null;
        checkpoint = staleCheckpoint;
        return {
          projectId,
          assetId: asset.id,
          generation,
          sourceRevision,
          status: 'failed',
          stale: true,
          providerJobId: checkpoint.providerJobId,
          providerStatus: 'stale',
          retryAttempts: checkpoint.retry.attempts,
          error: 'transcription result ignored because the source revision changed',
        };
      }

      const completedCheckpoint: TranscriptionCheckpoint = {
        ...checkpoint,
        providerStatus: 'completed',
        updatedAt: Date.now(),
      };
      await saveTranscriptionCheckpoint(completedCheckpoint);
      if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return null;
      checkpoint = completedCheckpoint;
      return {
        projectId,
        assetId: asset.id,
        generation,
        sourceRevision,
        status: 'done',
        words: result.words,
        providerJobId: checkpoint.providerJobId,
        providerStatus: 'completed',
        retryAttempts: checkpoint.retry.attempts,
      };
    } catch (error) {
      if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation) || !sourceIsCurrent()) return null;
      const message = error instanceof Error ? error.message : String(error);
      if (!checkpoint) {
        return {
          projectId,
          assetId: asset.id,
          generation,
          sourceRevision,
          status: 'failed',
          error: message,
        };
      }
      const failedCheckpoint: TranscriptionCheckpoint = {
        ...checkpoint,
        providerStatus: 'failed',
        retry: {
          ...checkpoint.retry,
          lastError: message,
          nextRetryAt: Date.now() + Math.min(60_000, 2 ** checkpoint.retry.attempts * 1_000),
        },
        updatedAt: Date.now(),
      };
      await saveTranscriptionCheckpoint(failedCheckpoint);
      if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return null;
      checkpoint = failedCheckpoint;
      return {
        projectId,
        assetId: asset.id,
        generation,
        sourceRevision,
        status: 'failed',
        providerJobId: checkpoint.providerJobId,
        providerStatus: 'failed',
        retryAttempts: checkpoint.retry.attempts,
        error: message,
      };
    }
  })().then((job) => {
    if (!job || !isCurrentGeneration(projectId, asset.id, sourceRevision, generation)) return;
    if (!job.stale && !sourceIsCurrent()) return;
    jobs.set(logicalJobKey, job);
    if (!job.stale) opts.onComplete?.(job);
  }).catch((error) => {
    if (!isCurrentGeneration(projectId, asset.id, sourceRevision, generation) || !sourceIsCurrent()) return;
    const current = jobs.get(logicalJobKey)!;
    const job: TranscribeJob = {
      ...current,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    jobs.set(logicalJobKey, job);
    opts.onComplete?.(job);
  });
}

/** Timeline transcript propagation is keyed by source identity, never display name. */
export function untranscribedTimelineItemIdsForRevision(
  items: readonly {
    id: string;
    sourceRevision?: string;
    transcript?: TranscriptWord[];
    transcriptStale?: boolean;
  }[],
  sourceRevision: string,
): string[] {
  return items
    .filter((item) => item.sourceRevision === sourceRevision && !hasOperationalTranscript(item))
    .map((item) => item.id);
}

/** Whether the pool UI can start/retry ASR for this asset: transcript-able
 *  kinds that are neither running nor already transcribed. */
export function assetCanTranscribe(
  kind: MediaAsset['kind'],
  transcribeStatus: MediaAsset['transcribeStatus'],
): boolean {
  return (kind === 'audio' || kind === 'video')
    && transcribeStatus !== 'running'
    && transcribeStatus !== 'done';
}

export function getTranscribeJob(projectId: string, assetId: string): TranscribeJob | undefined {
  return jobs.get(jobKey(projectId, assetId));
}

/** Wait until every listed asset's in-flight ASR job settles in one project, or timeout elapses.
 *  Assets with no live job (already persisted onto the asset, or never enqueued) are
 *  not waited on — track_progress reconciles those from the asset itself. */
export async function waitForTranscribeJobs(
  projectId: string,
  assetIds: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = assetIds.some((id) => {
      const job = jobs.get(jobKey(projectId, id));
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
  sourceRevision?: string;
  providerJobId?: string;
  providerStatus?: TranscriptionProviderStatus;
  retryAttempts?: number;
}

export function transcriptionReport(
  assetId: string,
  job: TranscribeJob | undefined,
  assetWordCount: number,
): TranscriptionReport {
  const provider = job ? {
    sourceRevision: job.sourceRevision,
    providerJobId: job.providerJobId,
    providerStatus: job.providerStatus,
    retryAttempts: job.retryAttempts,
  } : {};
  if (job?.status === 'done') {
    return { assetId, ...provider, status: 'succeeded', wordCount: job.words?.length ?? assetWordCount };
  }
  if (job?.status === 'failed') return { assetId, ...provider, status: 'failed', error: job.error };
  if (job?.status === 'running') return { assetId, ...provider, status: 'running' };
  // No live job: fall back to what's persisted on the asset.
  if (assetWordCount > 0) return { assetId, status: 'succeeded', wordCount: assetWordCount };
  return { assetId, status: 'not_found' };
}
