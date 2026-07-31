import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, mkdir, rename, stat } from 'node:fs/promises';
import { normalizeFrameRange } from '../../src/export/range.ts';
import {
  resolveH264RenderOptions,
  resolveH264TargetBitrate,
  type H264EncoderOutcome,
} from '../media-acceleration.ts';
import { ffmpegBin } from '../media-binaries.ts';
import {
  EXPORT_MEDIA,
  exportDuration,
  exportFilename,
  exportScale,
  planExport,
  validateVideoParams,
  type ExportPlan,
  type ExportRequest,
  type ExportTimeline,
} from './export-plan.ts';
import {
  acquireExportPermit,
  cancelActiveExportJob,
  cleanupStaleExportFiles,
  createRenderProgress,
  EXPORT_JOB_RETENTION_MS,
  exportJobFilename,
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

import { uploadDir } from '../media-dir.ts';
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
  try {
    update({ phase: 'preparing', progress: 4, processedFrames: 0, totalFrames: plan.totalFrames });
    await mkdir(dirname(filepath), { recursive: true });
    update({ phase: 'rendering', progress: 8 });
    const rendered = await renderTimeline({
      state: plan.state,
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
    await Promise.all([unlink(filepath).catch(() => {}), retimed ? unlink(retimed).catch(() => {}) : Promise.resolve()]);
    throw error;
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
        try {
          const body = (await readJsonBody(req)) as {
            state?: unknown;
            frames?: unknown;
            grid?: boolean;
            fps?: number;
          } | null;
          const state = body?.state;
          const frames = body?.frames;
          if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
            sendError(res, 400, 'body must be { state, frames[] }');
            return;
          }
          if (!Array.isArray(frames) || !frames.length || !frames.every((f) => typeof f === 'number')) {
            sendError(res, 400, 'frames must be a non-empty number[]');
            return;
          }
          const rendered = await renderTimelineStills({ state, frames }) as Array<{ frame: number; base64: string }>;
          const fps = typeof body?.fps === 'number' && body.fps > 0
            ? body.fps
            : Number((state as { fps?: unknown }).fps) || 30;
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
        }
      });
      server.middlewares.use('/render-clip', async (req, res) => {
        if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
        let tmpOut: string | null = null;
        let bakeOut: string | null = null;
        try {
          const body = (await readJsonBody(req)) as { state?: unknown; codec?: string; transparent?: boolean; mode?: string; filename?: string } | null;
          const state = body?.state;
          if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
            sendError(res, 400, 'body must be { state, codec, mode }'); return;
          }
          const codec = typeof body?.codec === 'string' && body.codec in CLIP_EXT ? body.codec : 'h264';
          const ext = CLIP_EXT[codec];
          const mode = body?.mode === 'bake' ? 'bake' : 'download';
          const transparent = body?.transparent ?? codec === 'prores';
          if (mode === 'bake') {
            const dir = uploadDir();
            await mkdir(dir, { recursive: true });
            const fname = `${randomUUID()}.${ext}`;
            bakeOut = join(dir, fname);
            await withExportPermit(async () => renderClip({ state, outputLocation: bakeOut, codec, transparent, ...await h264RenderOptions(codec) }));
            bakeOut = null;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path: `/media/uploads/${fname}` }));
          } else {
            tmpOut = join(tmpdir(), `openchatcut-clip-${randomUUID()}.${ext}`);
            await withExportPermit(async () => renderClip({ state, outputLocation: tmpOut, codec, transparent, ...await h264RenderOptions(codec) }));
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
          if (!res.headersSent) sendError(res, 500, message);
          else res.end();
        } finally {
          if (tmpOut) await unlink(tmpOut).catch(() => {});
          if (bakeOut) await unlink(bakeOut).catch(() => {});
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
          sendJson(res, 200, snapshot);
          return;
        }
        if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — POST to enqueue, GET to inspect, DELETE to clean up'); return; }
        if (id) { sendError(res, 404, 'unknown export job route'); return; }

        try {
          const body = (await readJsonBody(req)) as ExportRequest | null;
          const plan = planExport(body);
          const uuid = randomUUID();
          const outDir = uploadDir();
          const filename = exportJobFilename(uuid, plan.media.ext);
          const filepath = join(outDir, filename);
          const publicPath = `/media/uploads/${filename}`;
          const controller = new AbortController();
          const { jobId } = createGenerationJob(
            {
              kind: 'export',
              format: plan.format,
              codec: plan.media.codec,
              name: plan.filename,
              frameRange: plan.frameRange ?? null,
              totalFrames: plan.totalFrames,
            },
            async (_jobId, update) => {
              try {
                const encoding = await renderExportPlan(plan, filepath, update, controller.signal);
                const { size } = await stat(filepath);
                const sourceFps = Number((plan.state as { fps?: unknown }).fps);
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
                await unlink(filepath).catch(() => {});
                throw error;
              }
            },
            {
              acquire: () => acquireExportPermit(controller.signal),
              cleanupResult: async () => { await unlinkWithRetry(filepath); },
              onSettled: forgetExportJobController,
            },
          );
          trackExportJobController(jobId, controller);
          sendJson(res, 200, { renderId: jobId });
        } catch (err) {
          sendError(res, 400, err instanceof Error ? err.message : String(err));
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
        try {
          const body = await readJsonBody(req) as ExportRequest | null;
          const state = body?.state;
          if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
            sendError(res, 400, 'body must be { state: TimelineState } with an items array');
            return;
          }
          const fps = (state as ExportTimeline).fps;
          if (!Number.isFinite(fps) || fps <= 0) {
            sendError(res, 400, 'state.fps must be a positive number');
            return;
          }
          if (body?.format !== undefined && body.format !== 'video' && body.format !== 'audio') {
            sendError(res, 400, 'format must be video or audio');
            return;
          }
          if (body?.codec !== undefined && !['h264', 'vp8', 'mp3', 'wav'].includes(body.codec)) {
            sendError(res, 400, 'codec must be h264, vp8, mp3, or wav');
            return;
          }
          if (body?.name !== undefined && typeof body.name !== 'string') {
            sendError(res, 400, 'name must be a string');
            return;
          }
          if ([body.startSeconds, body.endSeconds].some((value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) {
            sendError(res, 400, 'startSeconds and endSeconds must be finite numbers');
            return;
          }

          const format = body.format ?? 'video';
          const codec = body.codec ?? (format === 'audio' ? 'mp3' : 'h264');
          if ((format === 'audio') !== (codec === 'mp3' || codec === 'wav')) {
            sendError(res, 400, `${format} export does not support codec=${codec}`);
            return;
          }
          try {
            validateVideoParams(body, format);
          } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : String(err));
            return;
          }
          const media = EXPORT_MEDIA[codec];
          const startFrame = body.startFrame ?? (body.startSeconds === undefined ? undefined : Math.floor(body.startSeconds * fps));
          const endFrameExclusive = body.endFrameExclusive ?? (body.endSeconds === undefined ? undefined : Math.ceil(body.endSeconds * fps));
          const frameRange = normalizeFrameRange(
            exportDuration(state as ExportTimeline),
            startFrame,
            endFrameExclusive,
          );
          const filename = exportFilename(body.name, media.ext);

          const finalOutput = join(tmpdir(), `openchatcut-export-${randomUUID()}.${media.ext}`);
          outputLocation = finalOutput;
          const scale = exportScale(state as { width?: unknown; height?: unknown }, body.resolution);
          await withExportPermit(async () => {
            await renderTimeline({
              state,
              outputLocation: finalOutput,
              codec: media.codec,
              frameRange,
              scale,
              videoBitrate: format === 'video' ? body.videoBitrate : undefined,
              ...await h264RenderOptions(media.codec),
            });
            if (format === 'video' && body.fps !== undefined && body.fps !== fps) {
              retimedOutput = `${finalOutput}.retimed.${media.ext}`;
              const outputSize = exportOutputSize(state, scale);
              await retimeFps(
                finalOutput,
                retimedOutput,
                body.fps,
                media.codec as 'h264' | 'vp8',
                body.videoBitrate ?? resolveH264TargetBitrate({ ...outputSize, fps: body.fps }),
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
          const message = err instanceof Error ? err.message : String(err);
          const status = err instanceof RangeError ? 400 : 500;
          if (status === 500) server.config.logger.error(`[export] ${message}`);
          if (!res.headersSent) sendError(res, status, message);
          else res.end();
        } finally {
          if (outputLocation) await unlink(outputLocation).catch(() => {});
          if (retimedOutput) await unlink(retimedOutput).catch(() => {});
        }
      });
    },
  };
}
