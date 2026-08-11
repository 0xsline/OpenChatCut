import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { resolveH264TargetBitrate } from '../media-acceleration.ts';
import { uploadDir } from '../media-dir.ts';
import {
  createExportFailure,
  exportFailureFrom,
  ExportFailureError,
  isExportFailure,
} from '../../src/export/exportFailure.ts';
import type { ExportPlan, ExportRequest } from './export-plan.ts';
import { acceptExportSubmission, type AcceptedExportSubmission } from './export-submission.ts';
import {
  acquireExportPermit,
  cancelActiveExportJob,
  exportJobFilename,
  exportOutputSize,
  forgetExportJobController,
  retimeFps,
  trackExportJobController,
  withExportPermit,
} from './export-runtime.ts';
import {
  createGenerationJob,
  deleteGenerationJob,
  getGenerationJobSnapshot,
} from './generation-jobs.ts';
import {
  bindRequestAbort,
  contentDisposition,
  exportOperationId,
  readJsonBody,
  sendError,
  sendExportFailure,
  sendJson,
  sendSequenceGraphFailure,
} from './export-http.ts';
import {
  cleanupExportOutputs,
  exportCapabilities,
  h264RenderOptions,
  renderExportPlan,
  renderTimeline,
} from './export-rendering.ts';

function isExportCapabilitiesPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0].replace(/\/+$/, '');
  return path === '/capabilities' || path === '/export/capabilities';
}

export function registerExportJobRoute(server: ViteDevServer): void {
  server.middlewares.use('/export/job', async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const id = path.replace(/^\/+|\/+$/g, '');

    if (req.method === 'DELETE') {
      if (!id) { sendError(res, 400, 'render id is required'); return; }
      const snapshot = getGenerationJobSnapshot(id);
      if (!snapshot) { sendError(res, 404, `render job ${id} not found`); return; }
      if (snapshot.status === 'queued' || snapshot.status === 'running') {
        if (!await cancelActiveExportJob(id)) {
          sendError(res, 409, 'render job cancellation timed out'); return;
        }
      } else {
        await deleteGenerationJob(id);
      }
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET') {
      if (!id) { sendError(res, 400, 'render id is required'); return; }
      const snapshot = getGenerationJobSnapshot(id);
      if (!snapshot) { sendError(res, 404, `render job ${id} not found`); return; }
      const failure = isExportFailure(snapshot.params.exportFailure)
        ? snapshot.params.exportFailure
        : undefined;
      sendJson(res, 200, failure ? { ...snapshot, failure } : snapshot);
      return;
    }
    if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — POST to enqueue, GET to inspect, DELETE to clean up'); return; }
    if (id) { sendError(res, 404, 'unknown export job route'); return; }
    const requestAbort = bindRequestAbort(req, res);
    const controller = requestAbort.controller;

    let acceptedSubmission: AcceptedExportSubmission | undefined;
    let queued = false;
    try {
      const body = (await readJsonBody(req)) as ExportRequest | null;
      controller.signal.throwIfAborted();
      acceptedSubmission = await acceptExportSubmission(body, { signal: controller.signal });
      const { plan } = acceptedSubmission;
      const operationId = exportOperationId(body);
      const cleanupRenderMedia = acceptedSubmission.cleanup;
      const uuid = randomUUID();
      const outDir = uploadDir();
      const filename = exportJobFilename(uuid, plan.media.ext);
      const filepath = join(outDir, filename);
      const publicPath = `/media/uploads/${filename}`;
      controller.signal.throwIfAborted();
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
            const encoding = await renderExportPlan(plan, filepath, update, controller.signal);
            const { size } = await stat(filepath);
            controller.signal.throwIfAborted();
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
              ...(encoding ?? {}),
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
            throw new ExportFailureError(failure);
          } finally {
            await cleanupRenderMedia();
          }
        },
        {
          ...(operationId ? { operationId } : {}),
          acquire: async () => {
            try {
              return await acquireExportPermit(controller.signal);
            } catch (error) {
              await cleanupRenderMedia();
              const failure = createExportFailure({
                stage: controller.signal.aborted ? 'cancel' : 'queue',
                code: controller.signal.aborted ? 'export_cancelled' : 'export_queue_failed',
                retryable: !controller.signal.aborted,
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
            void cleanupRenderMedia().catch((error) => {
              server.config.logger.warn(
                `[export] failed to clean materialized media: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          },
        },
      );
      queued = true;
      trackExportJobController(jobId, controller);
      controller.signal.throwIfAborted();
      requestAbort.dispose();
      sendJson(res, 200, { renderId: jobId });
    } catch (error) {
      if (acceptedSubmission && !queued) await acceptedSubmission.cleanup().catch(() => undefined);
      if (controller.signal.aborted) return;
      if (sendSequenceGraphFailure(res, error)) return;
      const failure = exportFailureFrom(error);
      if (failure) sendExportFailure(res, failure.stage === 'preflight' ? 422 : 500, failure);
      else sendError(res, 400, error instanceof Error ? error.message : String(error));
    } finally {
      requestAbort.dispose();
    }
  });
}

export function registerExportRoute(server: ViteDevServer): void {
  server.middlewares.use('/export', async (req, res) => {
    if (req.method === 'GET' && isExportCapabilitiesPath(req.url)) {
      try {
        sendJson(res, 200, await exportCapabilities());
      } catch (error) {
        sendError(res, 500, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed — use POST');
      return;
    }
    const requestAbort = bindRequestAbort(req, res);

    let outputLocation: string | null = null;
    let retimedOutput: string | null = null;
    let acceptedSubmission: AcceptedExportSubmission | undefined;
    try {
      const body = await readJsonBody(req) as ExportRequest | null;
      requestAbort.controller.signal.throwIfAborted();
      let plan: ExportPlan;
      try {
        acceptedSubmission = await acceptExportSubmission(
          body,
          { signal: requestAbort.controller.signal },
        );
        plan = acceptedSubmission.plan;
      } catch (error) {
        if (requestAbort.controller.signal.aborted) throw error;
        if (sendSequenceGraphFailure(res, error)) return;
        const failure = exportFailureFrom(error);
        if (failure) sendExportFailure(res, failure.stage === 'preflight' ? 422 : 500, failure);
        else sendError(res, 400, error instanceof Error ? error.message : String(error));
        return;
      }
      const { state, format, media, frameRange, filename, scale } = plan;
      const finalOutput = join(tmpdir(), `openchatcut-export-${randomUUID()}.${media.ext}`);
      outputLocation = finalOutput;
      await withExportPermit(async () => {
        await renderTimeline({
          state,
          project: plan.project,
          timelineId: plan.timelineId,
          outputLocation: finalOutput,
          codec: media.codec,
          frameRange,
          scale,
          videoBitrate: plan.videoBitrate,
          ...await h264RenderOptions(media.codec),
          signal: requestAbort.controller.signal,
        });
        requestAbort.controller.signal.throwIfAborted();
        if (format === 'video' && plan.retimeFps !== undefined) {
          retimedOutput = `${finalOutput}.retimed.${media.ext}`;
          const outputSize = exportOutputSize(state, scale);
          await retimeFps(
            finalOutput,
            retimedOutput,
            plan.retimeFps,
            media.codec as 'h264' | 'vp8',
            plan.videoBitrate ?? resolveH264TargetBitrate({ ...outputSize, fps: plan.retimeFps }),
            requestAbort.controller.signal,
          );
          requestAbort.controller.signal.throwIfAborted();
          await unlink(finalOutput).catch(() => {});
          requestAbort.controller.signal.throwIfAborted();
          await rename(retimedOutput, finalOutput);
          requestAbort.controller.signal.throwIfAborted();
          retimedOutput = null;
        }
      }, requestAbort.controller.signal);
      requestAbort.controller.signal.throwIfAborted();

      const buffer = await readFile(finalOutput, { signal: requestAbort.controller.signal });
      requestAbort.controller.signal.throwIfAborted();
      res.statusCode = 200;
      res.setHeader('Content-Type', media.mime);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Content-Disposition', contentDisposition(filename));
      res.end(buffer);
    } catch (error) {
      const cleanupStatus = await cleanupExportOutputs([outputLocation, retimedOutput]);
      outputLocation = null;
      retimedOutput = null;
      if (requestAbort.controller.signal.aborted) return;
      const existing = exportFailureFrom(error);
      const failure = existing ?? createExportFailure({
        stage: 'render',
        code: 'export_render_failed',
        retryable: true,
        cleanupStatus,
        targetPath: null,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendExportFailure(res, error instanceof RangeError ? 400 : 500, failure);
      else res.end();
    } finally {
      if (outputLocation) await unlink(outputLocation).catch(() => {});
      if (retimedOutput) await unlink(retimedOutput).catch(() => {});
      await acceptedSubmission?.cleanup();
      requestAbort.dispose();
    }
  });
}
