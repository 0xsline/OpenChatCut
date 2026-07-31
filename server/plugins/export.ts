import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, mkdir, rename, stat } from 'node:fs/promises';
import {
  resolveH264RenderOptions,
  resolveH264TargetBitrate,
  type H264EncoderOutcome,
} from '../media-acceleration.ts';
import { ffmpegBin } from '../media-binaries.ts';
import {
  type ExportPlan,
  type ExportRequest,
} from './export-plan.ts';
import { isSequenceGraphError } from '../../src/editor/sequenceGraph.ts';
import { acceptExportSubmission, type AcceptedExportSubmission } from './export-submission.ts';
import {
  createExportFailure,
  exportFailureFrom,
  ExportFailureError,
  isExportFailure,
  type ExportCleanupStatus,
  type ExportFailure,
  type ExportFailureStage,
} from '../../src/export/exportFailure.ts';
import {
  acquireExportPermit,
  cancelActiveExportJob,
  cleanupStaleExportFiles,
  createRenderProgress,
  EXPORT_JOB_RETENTION_MS,
  exportJobFilename,
  exportJobResultName,
  finalH264EncoderOutcome,
  exportOutputSize,
  forgetExportJobController,
  retimeFps,
  unlinkWithRetry,
  trackExportJobController,
  withExportPermit,
} from './export-runtime.ts';
import {
  createGenerationJob,
  deleteGenerationJob,
  getGenerationJobSnapshot,
  registerGenerationCleanupPolicy,
  type UpdateGenerationJob,
} from './generation-jobs.ts';
// @ts-expect-error — plain .mjs render pipeline has no .d.ts
import * as remotionRender from '../../remotion/render.mjs';
const {
  currentRenderConcurrency,
  remotionFfmpegPath,
  renderTimeline,
  renderTimelineStills,
  renderClip,
  setUploadsDirProvider,
} = remotionRender;

import { resolveUploadFile, uploadDir } from '../media-dir.ts';
import { sanitizeFileName } from '../file-name.ts';
import { formatFrameLabel, tileContactSheet } from '../frame-grid.ts';

export { EXPORT_FPS_OPTIONS, EXPORT_RESOLUTIONS, exportScale, validateVideoParams } from './export-plan.ts';
export type { ExportResolution } from './export-plan.ts';
const CLIP_EXT: Record<string, string> = { prores: 'mov', vp8: 'webm', vp9: 'webm', h264: 'mp4' };
const CLIP_MIME: Record<string, string> = { mov: 'video/quicktime', webm: 'video/webm', mp4: 'video/mp4' };

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB — timelines carry inlined template code.

// RFC 5987: filename= is a latin-1 field. If Chinese UTF-8 bytes are inserted directly, the browser will press latin-1
// Decode into gibberish. Give an ASCII backend filename= + filename*=UTF-8'' percent encoding (same as server/plugins/captions).
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
function sendSequenceGraphFailure(res: ServerResponse, error: unknown): boolean {
  if (!isSequenceGraphError(error)) return false;
  sendJson(res, 422, {
    error: error.message,
    code: error.code,
    path: error.path,
    limit: error.limit,
    itemId: error.itemId,
    timelineId: error.timelineId,
    referencedTimelineId: error.referencedTimelineId,
    parentFps: error.parentFps,
    childFps: error.childFps,
  });
  return true;
}


function sendExportFailure(res: ServerResponse, status: number, failure: ExportFailure): void {
  sendJson(res, status, { error: failure.message, failure });
}

async function cleanupExportOutputs(paths: Array<string | null>): Promise<ExportCleanupStatus> {
  let cleanupStatus: ExportCleanupStatus = 'succeeded';
  await Promise.all(paths.filter((path): path is string => path !== null).map(async (path) => {
    try {
      await unlink(path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanupStatus = 'failed';
    }
  }));
  return cleanupStatus;
}

async function h264RenderOptions(codec: string) {
  return codec === 'h264'
    ? resolveH264RenderOptions(ffmpegBin(), remotionFfmpegPath())
    : {};
}

async function renderExportPlan(
  plan: ExportPlan,
  filepath: string,
  update: UpdateGenerationJob,
  signal?: AbortSignal,
): Promise<H264EncoderOutcome | undefined> {
  const retimed = plan.retimeFps ? `${filepath}.retimed.${plan.media.ext}` : null;
  let failureStage: ExportFailureStage = 'render';
  try {
    update({ phase: 'preparing', progress: 4, processedFrames: 0, totalFrames: plan.totalFrames });
    await mkdir(dirname(filepath), { recursive: true });
    update({ phase: 'rendering', progress: 8 });
    const rendered = await renderTimeline({
      state: plan.state,
      project: plan.project,
      timelineId: plan.timelineId,
      outputLocation: filepath,
      codec: plan.media.codec,
      frameRange: plan.frameRange,
      scale: plan.scale,
      videoBitrate: plan.videoBitrate,
      ...await h264RenderOptions(plan.media.codec),
      onProgress: createRenderProgress(update, plan.totalFrames, plan.retimeFps ? 84 : 90),
      signal,
    }) as Partial<H264EncoderOutcome>;
    let outcome = rendered.encoder ? { encoder: rendered.encoder, ...(rendered.encoderFallbackReason ? { encoderFallbackReason: rendered.encoderFallbackReason } : {}) } : undefined;
    if (retimed && plan.retimeFps) {
      failureStage = 'encode';
      update({ phase: 'finalizing', progress: 93, processedFrames: plan.totalFrames });
      const outputSize = exportOutputSize(plan.state, plan.scale);
      outcome = finalH264EncoderOutcome(outcome, await retimeFps(
        filepath,
        retimed,
        plan.retimeFps,
        plan.media.codec as 'h264' | 'vp8',
        plan.videoBitrate ?? resolveH264TargetBitrate({ ...outputSize, fps: plan.retimeFps }),
        signal,
      ));
      await unlink(filepath).catch(() => {});
      await rename(retimed, filepath);
    }
    update({ phase: 'finalizing', progress: 99, processedFrames: plan.totalFrames });
    return outcome;
  } catch (error) {
    const cleanupStatus = await cleanupExportOutputs([filepath, retimed]);
    const existing = exportFailureFrom(error);
    if (existing) {
      throw new ExportFailureError({ ...existing, cleanupStatus, targetPath: filepath });
    }
    const aborted = signal?.aborted === true;
    const timedOut = error instanceof Error && /(?:timed?\\s*out|timeout)/i.test(error.message);
    throw new ExportFailureError(createExportFailure({
      stage: aborted ? 'cancel' : timedOut ? 'timeout' : failureStage,
      code: aborted ? 'export_cancelled' : timedOut ? 'export_timeout'
        : failureStage === 'encode' ? 'export_encode_failed' : 'export_render_failed',
      retryable: !aborted,
      cleanupStatus,
      targetPath: filepath,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function isExportCapabilitiesPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0].replace(/\/+$/, '');
  return path === '/capabilities' || path === '/export/capabilities';
}

async function exportCapabilities() {
  const { h264Profile } = await resolveH264RenderOptions(ffmpegBin(), remotionFfmpegPath());
  return { h264: h264Profile, renderConcurrency: currentRenderConcurrency() };
}

export function exportPlugin(): Plugin {
  registerGenerationCleanupPolicy('server-export', async (result) => {
    const name = exportJobResultName(result.path, result.assetId);
    if (!name) throw new Error(`refusing to clean invalid server export result ${result.path}`);
    const file = resolveUploadFile(name);
    if (file) await unlinkWithRetry(file);
  });
  return {
    name: 'openchatcut-export',
    configureServer(server) {
      setUploadsDirProvider(uploadDir);
      const cleanStaleExports = () => cleanupStaleExportFiles(uploadDir(), {
          onError: (path, error) => server.config.logger.warn(
            `[export] failed to clean stale artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        }).then((removed) => {
          if (removed > 0) server.config.logger.info(`[export] removed ${removed} stale export artifact(s)`);
        }).catch((error) => {
          server.config.logger.warn(`[export] stale artifact scan failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      void cleanStaleExports();
      const cleanupTimer = setInterval(() => { void cleanStaleExports(); }, EXPORT_JOB_RETENTION_MS);
      cleanupTimer.unref?.();
      server.httpServer?.once('close', () => clearInterval(cleanupTimer));

      // POST /render-still { state, frames:[n], grid?, fps? }
      //   → { frames: [{frame, base64}], gridBase64?, renderedBy: 'remotion' }
      // grid=true (default when ≥2 frames): one labeled contact-sheet JPEG for vision.
      // (backs view_timeline_frames: the agent renders stills to "see" its edits)
      server.middlewares.use('/render-still', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }
        let cleanupRenderMedia: (() => Promise<void>) | undefined;
        try {
          const body = (await readJsonBody(req)) as {
            state?: unknown;
            project?: unknown;
            timelineId?: unknown;
            frames?: unknown;
            grid?: boolean;
            fps?: number;
          } | null;
          const frames = body?.frames;
          if (!Array.isArray(frames) || !frames.length || !frames.every((frame) => typeof frame === 'number')) {
            sendError(res, 400, 'frames must be a non-empty number[]');
            return;
          }
          let plan: ExportPlan;
          try {
            const accepted = await acceptExportSubmission({
              state: body?.state,
              project: body?.project,
              timelineId: body?.timelineId,
            });
            plan = accepted.plan;
            cleanupRenderMedia = accepted.cleanup;
          } catch (error) {
            if (!sendSequenceGraphFailure(res, error)) {
              const failure = exportFailureFrom(error);
              if (failure) sendExportFailure(res, failure.stage === 'preflight' ? 422 : 500, failure);
              else sendError(res, 400, error instanceof Error ? error.message : String(error));
            }
            return;
          }
          const rendered = await renderTimelineStills({
            state: plan.state,
            project: plan.project,
            timelineId: plan.timelineId,
            frames,
          }) as Array<{ frame: number; base64: string }>;
          const fps = typeof body?.fps === 'number' && body.fps > 0 ? body.fps : plan.state.fps;
          const wantGrid = body?.grid !== false && rendered.length >= 2;
          let gridBase64: string | undefined;
          if (wantGrid) {
            try {
              const sheet = await tileContactSheet(
                rendered.map((r) => ({
                  jpeg: Buffer.from(r.base64, 'base64'),
                  label: formatFrameLabel(r.frame, fps),
                })),
                { cellWidth: rendered.length > 9 ? 280 : 320 },
              );
              gridBase64 = sheet.toString('base64');
            } catch (gridErr) {
              server.config.logger.info(
                `[render-still] grid tile failed, falling back to multi-image: ${gridErr instanceof Error ? gridErr.message : String(gridErr)}`,
              );
            }
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            frames: rendered,
            gridBase64,
            renderedBy: 'remotion',
          }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[render-still] ${message}`);
          if (!res.headersSent) sendError(res, 500, message);
          else res.end();
        } finally {
          await cleanupRenderMedia?.();
        }
      });
      server.middlewares.use('/render-clip', async (req, res) => {
        if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
        let tmpOut: string | null = null;
        let bakeOut: string | null = null;
        let cleanupRenderMedia: (() => Promise<void>) | undefined;
        try {
          const body = (await readJsonBody(req)) as { state?: unknown; codec?: string; transparent?: boolean; mode?: string; filename?: string } | null;
          const state = body?.state;
          if (!state || typeof state !== 'object' || !('items' in state) || !Array.isArray(state.items)) {
            sendError(res, 400, 'body must be { state, codec, mode }'); return;
          }
          const codec = typeof body?.codec === 'string' && body.codec in CLIP_EXT ? body.codec : 'h264';
          const accepted = await acceptExportSubmission({ state });
          cleanupRenderMedia = accepted.cleanup;
          const renderState = accepted.plan.state;
          const ext = CLIP_EXT[codec];
          const mode = body?.mode === 'bake' ? 'bake' : 'download';
          const transparent = body?.transparent ?? codec === 'prores';
          if (mode === 'bake') {
            const dir = uploadDir();
            await mkdir(dir, { recursive: true });
            const fname = `${randomUUID()}.${ext}`;
            bakeOut = join(dir, fname);
            await withExportPermit(async () => renderClip({
              state: renderState,
              outputLocation: bakeOut,
              codec,
              transparent,
              ...await h264RenderOptions(codec),
            }));
            bakeOut = null;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path: `/media/uploads/${fname}` }));
          } else {
            tmpOut = join(tmpdir(), `openchatcut-clip-${randomUUID()}.${ext}`);
            await withExportPermit(async () => renderClip({
              state: renderState,
              outputLocation: tmpOut,
              codec,
              transparent,
              ...await h264RenderOptions(codec),
            }));
            const buf = await readFile(tmpOut);
            const safe = sanitizeFileName(body?.filename ?? 'clip', 'clip');
            res.statusCode = 200;
            res.setHeader('Content-Type', CLIP_MIME[ext] ?? 'application/octet-stream');
            res.setHeader('Content-Length', String(buf.length));
            res.setHeader('Content-Disposition', contentDisposition(`${safe}.${ext}`));
            res.end(buf);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[render-clip] ${message}`);
          const failure = exportFailureFrom(err);
          if (!res.headersSent) {
            if (failure) sendExportFailure(res, failure.stage === 'preflight' ? 422 : 500, failure);
            else sendError(res, 500, message);
          } else res.end();
        } finally {
          if (tmpOut) await unlink(tmpOut).catch(() => {});
          if (bakeOut) await unlink(bakeOut).catch(() => {});
          await cleanupRenderMedia?.();
        }
      });

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

        let acceptedSubmission: AcceptedExportSubmission | undefined;
        let queued = false;
        try {
          const body = (await readJsonBody(req)) as ExportRequest | null;
          acceptedSubmission = await acceptExportSubmission(body);
          const { plan } = acceptedSubmission;
          const cleanupRenderMedia = acceptedSubmission.cleanup;
          const uuid = randomUUID();
          const outDir = uploadDir();
          const filename = exportJobFilename(uuid, plan.media.ext);
          const filepath = join(outDir, filename);
          const publicPath = `/media/uploads/${filename}`;
          const controller = new AbortController();
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
          sendJson(res, 200, { renderId: jobId });
        } catch (err) {
          if (acceptedSubmission && !queued) await acceptedSubmission.cleanup().catch(() => undefined);
          if (sendSequenceGraphFailure(res, err)) return;
          const failure = exportFailureFrom(err);
          if (failure) sendExportFailure(res, failure.stage === 'preflight' ? 422 : 500, failure);
          else sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
      });

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

        let outputLocation: string | null = null;
        let retimedOutput: string | null = null;
        let acceptedSubmission: AcceptedExportSubmission | undefined;
        try {
          const body = await readJsonBody(req) as ExportRequest | null;
          let plan: ExportPlan;
          try {
            acceptedSubmission = await acceptExportSubmission(body);
            plan = acceptedSubmission.plan;
          } catch (error) {
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
            });
            if (format === 'video' && plan.retimeFps !== undefined) {
              retimedOutput = `${finalOutput}.retimed.${media.ext}`;
              const outputSize = exportOutputSize(state, scale);
              await retimeFps(
                finalOutput,
                retimedOutput,
                plan.retimeFps,
                media.codec as 'h264' | 'vp8',
                plan.videoBitrate ?? resolveH264TargetBitrate({ ...outputSize, fps: plan.retimeFps }),
              );
              await unlink(finalOutput).catch(() => {});
              await rename(retimedOutput, finalOutput);
              retimedOutput = null;
            }
          });

          const buf = await readFile(finalOutput);
          res.statusCode = 200;
          res.setHeader('Content-Type', media.mime);
          res.setHeader('Content-Length', String(buf.length));
          res.setHeader('Content-Disposition', contentDisposition(filename));
          res.end(buf);
        } catch (err) {
          const cleanupStatus = await cleanupExportOutputs([outputLocation, retimedOutput]);
          outputLocation = null;
          retimedOutput = null;
          const existing = exportFailureFrom(err);
          const failure = existing ?? createExportFailure({
            stage: 'render',
            code: 'export_render_failed',
            retryable: true,
            cleanupStatus,
            targetPath: null,
            message: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) sendExportFailure(res, err instanceof RangeError ? 400 : 500, failure);
          else res.end();
        } finally {
          if (outputLocation) await unlink(outputLocation).catch(() => {});
          if (retimedOutput) await unlink(retimedOutput).catch(() => {});
          await acceptedSubmission?.cleanup();
        }
      });
    },
  };
}
