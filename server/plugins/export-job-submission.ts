import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadDir } from '../media-dir.ts';
import {
  createExportFailure,
  exportFailureFrom,
  ExportFailureError,
  type ExportFailure,
} from '../../src/export/exportFailure.ts';
import type { ExportRequest } from './export-plan.ts';
import { acceptExportSubmission } from './export-submission.ts';
import { exportOperationId } from './export-http.ts';
import {
  acquireExportPermit,
  assertNonEmptyExportBytes,
  exportJobFilename,
  exportOutputSize,
  forgetExportJobController,
  trackExportJobController,
} from './export-runtime.ts';
import { createGenerationJob } from './generation-jobs.ts';
import { cleanupExportOutputs, renderExportPlan } from './export-rendering.ts';

// Shared enqueue step for the asynchronous export job: POST /export/job serves
// it over HTTP, and external-agent/offline-export.ts calls it in-process for a
// headless MCP session. Keeping the job setup in one place means both callers
// produce the same artifact, cleanup, and failure semantics.

export interface StartExportJobOptions {
  /** Aborts the render; the caller owns the controller so it can also wire
   * request disconnects or a session cancellation. */
  controller: AbortController;
  /** Called from the render task when a failure is recorded on the job. */
  onRenderFailure?: (failure: ExportFailure) => void;
  /** Best-effort materialized-media cleanup failures (never fail the job). */
  onMediaCleanupError?: (error: unknown) => void;
}

/** Enqueue a render job and return its id. The render runs in the background;
 * callers poll/observe it like any other generation job. */
export async function startExportJob(
  body: ExportRequest | null,
  options: StartExportJobOptions,
): Promise<string> {
  const { controller, onRenderFailure, onMediaCleanupError } = options;
  const signal = controller.signal;
  const acceptedSubmission = await acceptExportSubmission(body, { signal });
  const { plan } = acceptedSubmission;
  const cleanupRenderMedia = acceptedSubmission.cleanup;
  let queued = false;
  try {
    const operationId = exportOperationId(body);
    const uuid = randomUUID();
    const outDir = uploadDir();
    const filename = exportJobFilename(uuid, plan.media.ext);
    const filepath = join(outDir, filename);
    const publicPath = `/media/uploads/${filename}`;
    signal.throwIfAborted();
    const jobParams: Record<string, unknown> = {
      kind: 'export',
      format: plan.format,
      codec: plan.media.codec,
      name: plan.filename,
      frameRange: plan.frameRange ?? null,
      totalFrames: plan.totalFrames,
    };
    const { jobId } = await createGenerationJob(
      jobParams,
      async (_jobId, update) => {
        try {
          const encoding = await renderExportPlan(plan, filepath, update, signal);
          const { size } = await stat(filepath);
          assertNonEmptyExportBytes(size);
          signal.throwIfAborted();
          const sourceFps = plan.state.fps;
          const outputSize = plan.format === 'video' ? exportOutputSize(plan.state, plan.scale) : undefined;
          return {
            assetId: uuid,
            kind: plan.format,
            name: plan.filename,
            path: publicPath,
            durationSeconds: plan.durationSeconds,
            sizeBytes: size,
            codec: plan.media.codec,
            ...encoding,
            ...(outputSize ? { ...outputSize, fps: plan.retimeFps ?? sourceFps } : {}),
            sourceStartSeconds: (plan.frameRange?.[0] ?? 0) / sourceFps,
          };
        } catch (error) {
          const existing = exportFailureFrom(error);
          const failure = existing ?? createExportFailure({
            stage: 'encode',
            code: 'export_output_unreadable',
            retryable: true,
            cleanupStatus: await cleanupExportOutputs([filepath]),
            targetPath: filepath,
            message: error instanceof Error ? error.message : String(error),
          });
          jobParams.exportFailure = failure;
          // Without this the only record of a server render failure is the
          // HTTP response. When the client then falls back to the browser and
          // that fails too, the browser's error is what surfaces and the
          // server's real cause is lost — which made an unexportable project
          // look like a browser codec problem. A cancel is the user's doing,
          // not a failure, so it stays out of the error log.
          if (failure.stage !== 'cancel' && !signal.aborted) onRenderFailure?.(failure);
          throw new ExportFailureError(failure);
        } finally {
          await cleanupRenderMedia();
        }
      },
      {
        ...(operationId ? { operationId } : {}),
        acquire: async () => {
          try {
            return await acquireExportPermit(signal);
          } catch (error) {
            await cleanupRenderMedia();
            const failure = createExportFailure({
              stage: signal.aborted ? 'cancel' : 'queue',
              code: signal.aborted ? 'export_cancelled' : 'export_queue_failed',
              retryable: !signal.aborted,
              cleanupStatus: 'not-required',
              targetPath: filepath,
              message: error instanceof Error ? error.message : String(error),
            });
            jobParams.exportFailure = failure;
            throw new ExportFailureError(failure);
          }
        },
        cleanupPolicy: 'server-export',
        onSettled: (jobId) => {
          forgetExportJobController(jobId);
          void cleanupRenderMedia().catch((error) => onMediaCleanupError?.(error));
        },
      },
    );
    queued = true;
    trackExportJobController(jobId, controller);
    signal.throwIfAborted();
    return jobId;
  } catch (error) {
    if (!queued) await acceptedSubmission.cleanup().catch(() => undefined);
    throw error;
  }
}
