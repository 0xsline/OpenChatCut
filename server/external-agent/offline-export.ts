import { join } from 'node:path';
import type { AgentContext } from '../../src/agent/context.js';
import { uploadNameOfSource } from '../media-dir.ts';
import type { ExportRequest } from '../plugins/export-plan.ts';
import type {
  GenerationJobSnapshot,
} from '../plugins/generation-jobs.ts';
import type {
  StartExportJobOptions,
} from '../plugins/export-job-submission.ts';

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 3600;
const POLL_INTERVAL_MS = 500;

type Args = Record<string, unknown>;

export interface OfflineExportDependencies {
  startExportJob: (body: ExportRequest | null, options: StartExportJobOptions) => Promise<string>;
  getGenerationJobSnapshot: (renderId: string) => GenerationJobSnapshot | null | undefined;
  promoteExportResult: <T extends { assetId: string; path: string; sizeBytes?: number }>(
    result: T,
    directory: string,
  ) => Promise<T>;
  uploadDir: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

// The render pipeline pulls Remotion, which the desktop server bundle has no
// other reason to carry until an external agent actually renders a video, so
// the real dependencies load lazily at first call (same policy as
// offline-executor.ts). Verifications inject stubs and never touch them.
async function serverDependencies(): Promise<OfflineExportDependencies> {
  const [submission, runtime, jobs, mediaDir] = await Promise.all([
    import('../plugins/export-job-submission.ts'),
    import('../plugins/export-runtime.ts'),
    import('../plugins/generation-jobs.ts'),
    import('../media-dir.ts'),
  ]);
  return {
    startExportJob: submission.startExportJob,
    getGenerationJobSnapshot: jobs.getGenerationJobSnapshot,
    promoteExportResult: runtime.promoteExportResult,
    uploadDir: mediaDir.uploadDir,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
  };
}

function timeoutSecondsOf(args: Args): number {
  if (typeof args.timeoutSeconds !== 'number' || !Number.isFinite(args.timeoutSeconds)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(0, args.timeoutSeconds));
}

function renderIdOf(args: Args): string | undefined {
  return typeof args.renderId === 'string' && args.renderId.trim()
    ? args.renderId.trim()
    : undefined;
}

function waitingResult(snapshot: GenerationJobSnapshot, waitExpired: boolean): Record<string, unknown> {
  return {
    ok: true,
    renderId: snapshot.id,
    status: snapshot.status,
    progress: snapshot.progress,
    ...(snapshot.phase ? { phase: snapshot.phase } : {}),
    ...(snapshot.processedFrames !== undefined ? { processedFrames: snapshot.processedFrames } : {}),
    ...(snapshot.totalFrames !== undefined ? { totalFrames: snapshot.totalFrames } : {}),
    ...(waitExpired ? {
      waitExpired: true,
      background: true,
      next: 'The render continues in the background. Call export_video again with this renderId to wait for the output; do not start another render for the same timeline.',
    } : {}),
  };
}

async function completedResult(
  snapshot: GenerationJobSnapshot,
  deps: OfflineExportDependencies,
): Promise<Record<string, unknown>> {
  if (!snapshot.result) throw new Error(`export job ${snapshot.id} completed without a result`);
  const promoted = await deps.promoteExportResult(snapshot.result, deps.uploadDir());
  const fileName = uploadNameOfSource(promoted.path);
  if (fileName === null) throw new Error(`export job ${snapshot.id} returned an invalid managed path`);
  return {
    ok: true,
    renderId: snapshot.id,
    status: 'completed',
    path: promoted.path,
    filePath: join(deps.uploadDir(), fileName),
    name: promoted.name,
    format: promoted.kind,
    codec: promoted.codec,
    sizeBytes: promoted.sizeBytes,
    durationSeconds: promoted.durationSeconds,
    ...(promoted.width !== undefined ? { width: promoted.width } : {}),
    ...(promoted.height !== undefined ? { height: promoted.height } : {}),
    ...(promoted.fps !== undefined ? { fps: promoted.fps } : {}),
    ...(promoted.sourceStartSeconds !== undefined ? { sourceStartSeconds: promoted.sourceStartSeconds } : {}),
  };
}

async function waitForExport(
  renderId: string,
  timeoutSeconds: number,
  deps: OfflineExportDependencies,
): Promise<Record<string, unknown>> {
  const deadline = timeoutSeconds === 0 ? Infinity : deps.now() + timeoutSeconds * 1000;
  for (;;) {
    const snapshot = deps.getGenerationJobSnapshot(renderId);
    if (!snapshot) return { error: `export job ${renderId} not found` };
    if (snapshot.status === 'succeeded') return completedResult(snapshot, deps);
    if (snapshot.status === 'failed') {
      return {
        error: snapshot.error ?? `export job ${renderId} failed`,
        renderId,
        status: snapshot.status,
        ...(snapshot.code ? { code: snapshot.code } : {}),
        ...(snapshot.retryable !== undefined ? { retryable: snapshot.retryable } : {}),
      };
    }
    if (deps.now() >= deadline) return waitingResult(snapshot, true);
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/** Build the export request from the draft the session would review. */
export function exportRequestFromDraft(ctx: AgentContext): ExportRequest {
  const project = ctx.getDoc();
  const timelineId = project.activeTimelineId;
  const state = project.timelines.find((timeline) => timeline.id === timelineId);
  if (!state) throw new Error(`active timeline ${timelineId} not found`);
  return { state, project, timelineId };
}

/** Overlay injected overrides; when the core four are all provided they are
 * used directly so a verification never loads the Remotion pipeline. */
function mergedDependencies(
  injected: Partial<OfflineExportDependencies> | undefined,
): OfflineExportDependencies | Promise<OfflineExportDependencies> {
  if (!injected) return serverDependencies();
  const { startExportJob, getGenerationJobSnapshot, promoteExportResult, uploadDir, sleep, now } = injected;
  if (startExportJob && getGenerationJobSnapshot && promoteExportResult && uploadDir) {
    return {
      startExportJob,
      getGenerationJobSnapshot,
      promoteExportResult,
      uploadDir,
      sleep: sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      now: now ?? (() => Date.now()),
    };
  }
  return serverDependencies().then((deps) => ({ ...deps, ...injected }));
}

/** Execute export_video in a headless MCP edit session. */
export async function executeOfflineExportVideo(
  name: string,
  args: Args,
  ctx: AgentContext,
  injected?: Partial<OfflineExportDependencies>,
): Promise<unknown> {
  if (name !== 'export_video') return { error: `unknown tool ${name}` };
  try {
    const deps = await mergedDependencies(injected);
    const requested = renderIdOf(args);
    let renderId: string;
    if (requested) {
      renderId = requested;
    } else {
      const body: ExportRequest = { ...exportRequestFromDraft(ctx) };
      for (const key of [
        'format', 'codec', 'name', 'startFrame', 'endFrameExclusive',
        'startSeconds', 'endSeconds', 'resolution', 'fps', 'videoBitrate',
      ] as const) {
        if (args[key] !== undefined) (body as Record<string, unknown>)[key] = args[key];
      }
      const controller = new AbortController();
      renderId = await deps.startExportJob(body, {
        controller,
        onRenderFailure: (failure) => console.error(`[export_video] ${failure.message}`),
      });
    }
    return waitForExport(renderId, timeoutSecondsOf(args), deps);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}