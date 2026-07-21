import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, mkdir, rename, stat } from 'node:fs/promises';
import { normalizeFrameRange } from '../../src/export/range.ts';
import { resolveH264TargetBitrate } from '../media-acceleration.ts';
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
  exportOutputSize,
  retimeFps,
  withExportPermit,
} from './export-runtime.ts';
import {
  createGenerationJob,
  deleteGenerationJob,
  getGenerationJobSnapshot,
  type UpdateGenerationJob,
} from './generation-jobs.ts';
// @ts-expect-error — plain .mjs render pipeline has no .d.ts
import { renderTimeline, renderTimelineStills, renderClip, setUploadsDirProvider } from '../../remotion/render.mjs';

import { uploadDir } from '../media-dir.ts';
import { sanitizeFileName } from '../file-name.ts';
import { formatFrameLabel, tileContactSheet } from '../frame-grid.ts';

export { EXPORT_FPS_OPTIONS, EXPORT_RESOLUTIONS, exportScale, validateVideoParams } from './export-plan.ts';
export type { ExportResolution } from './export-plan.ts';
const CLIP_EXT: Record<string, string> = { prores: 'mov', vp8: 'webm', vp9: 'webm', h264: 'mp4' };
const CLIP_MIME: Record<string, string> = { mov: 'video/quicktime', webm: 'video/webm', mp4: 'video/mp4' };

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB — timelines carry inlined template code.

// RFC 5987：filename= 是 latin-1 字段，中文 UTF-8 字节直接塞进去会被浏览器按 latin-1
// 解码成乱码。给一个 ASCII 兜底 filename= + filename*=UTF-8'' 百分号编码（同 server/plugins/subtitles）。
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

async function renderExportPlan(
  plan: ExportPlan,
  filepath: string,
  update: UpdateGenerationJob,
): Promise<void> {
  const retimed = plan.retimeFps ? `${filepath}.retimed.${plan.media.ext}` : null;
  try {
    update({ phase: 'preparing', progress: 4, processedFrames: 0, totalFrames: plan.totalFrames });
    await mkdir(dirname(filepath), { recursive: true });
    update({ phase: 'rendering', progress: 8 });
    const renderSpan = plan.retimeFps ? 84 : 90;
    await renderTimeline({
      state: plan.state,
      outputLocation: filepath,
      codec: plan.media.codec,
      frameRange: plan.frameRange,
      scale: plan.scale,
      onProgress: (value: number) => {
        const normalized = Math.min(1, Math.max(0, Number(value) || 0));
        update({
          phase: 'rendering',
          progress: 8 + normalized * renderSpan,
          processedFrames: Math.min(plan.totalFrames, Math.floor(normalized * plan.totalFrames)),
          totalFrames: plan.totalFrames,
        });
      },
    });
    if (retimed && plan.retimeFps) {
      update({ phase: 'finalizing', progress: 93, processedFrames: plan.totalFrames });
      const outputSize = exportOutputSize(plan.state, plan.scale);
      await retimeFps(filepath, retimed, plan.retimeFps, plan.media.codec as 'h264' | 'vp8',
        resolveH264TargetBitrate({ ...outputSize, fps: plan.retimeFps }));
      await unlink(filepath).catch(() => {});
      await rename(retimed, filepath);
    }
    update({ phase: 'finalizing', progress: 99, processedFrames: plan.totalFrames });
  } catch (error) {
    await Promise.all([unlink(filepath).catch(() => {}), retimed ? unlink(retimed).catch(() => {}) : Promise.resolve()]);
    throw error;
  }
}

/**
 * Dev-server plugin exposing `POST /export`: body `{ state, format?, ... }` →
 * rendered MP4/WebM/MP3/WAV. Same pipeline as the CLI export —
 * the timeline is rendered in headless Chrome.
 */
export function exportPlugin(): Plugin {
  return {
    name: 'openchatcut-export',
    configureServer(server) {
      // 渲染 bundle 的 /media/uploads symlink 跟随 MEDIA_DIR(自定义素材目录也能渲染)
      setUploadsDirProvider(uploadDir);

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
      // POST /render-clip { state (single-clip), codec, transparent, mode } →
      //   mode 'download' streams the rendered file (导出 MG 动画: ProRes 4444 alpha);
      //   mode 'bake' saves it under uploads and returns { path } (转为视频).
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
            await withExportPermit(() => renderClip({ state, outputLocation: bakeOut, codec, transparent }));
            bakeOut = null;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path: `/media/uploads/${fname}` }));
          } else {
            tmpOut = join(tmpdir(), `openchatcut-clip-${randomUUID()}.${ext}`);
            await withExportPermit(() => renderClip({ state, outputLocation: tmpOut, codec, transparent }));
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

      // 异步渲染 job（submit_export 视频/音频异步语义 + track_export 轮询）：
      //   POST /export/job     → 入队渲染，立即返回 { renderId }（真正的渲染在后台队列跑）。
      //   GET  /export/job/:id → 返回 job 快照（status/progress/result/error），未知 → 404。
      // 必须注册在 /export 之前：connect 前缀匹配下 '/export' 也会命中 '/export/job'，先注册先执行。
      // 渲染产物落 uploadDir()/<uuid>.<ext>（默认 public/media/uploads），浏览器完成后按 result.path 直接取。
      server.middlewares.use('/export/job', async (req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        const id = path.replace(/^\/+|\/+$/g, '');

        if (req.method === 'DELETE') {
          if (!id) { sendError(res, 400, 'render id is required'); return; }
          const snapshot = getGenerationJobSnapshot(id);
          if (!snapshot) { sendError(res, 404, `render job ${id} not found`); return; }
          if (snapshot.status === 'queued' || snapshot.status === 'running') {
            sendError(res, 409, 'render job is still running'); return;
          }
          await deleteGenerationJob(id);
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
          const filepath = join(outDir, `${uuid}.${plan.media.ext}`);
          const publicPath = `/media/uploads/${uuid}.${plan.media.ext}`;
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
                await renderExportPlan(plan, filepath, update);
                const { size } = await stat(filepath);
                return { assetId: uuid, kind: plan.format, name: plan.filename, path: publicPath, durationSeconds: plan.durationSeconds, sizeBytes: size, codec: plan.media.codec };
              } catch (error) {
                await unlink(filepath).catch(() => {});
                throw error;
              }
            },
            {
              acquire: acquireExportPermit,
              cleanupResult: async () => { await unlink(filepath).catch(() => {}); },
            },
          );
          sendJson(res, 200, { renderId: jobId });
        } catch (err) {
          // 仅同步的入参/JSON 校验会落这里（渲染失败在 job 内部记录）。
          sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
      });

      server.middlewares.use('/export', async (req, res) => {
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
            await renderTimeline({ state, outputLocation: finalOutput, codec: media.codec, frameRange, scale });
            if (format === 'video' && body.fps !== undefined && body.fps !== fps) {
              retimedOutput = `${finalOutput}.retimed.${media.ext}`;
              const outputSize = exportOutputSize(state, scale);
              await retimeFps(finalOutput, retimedOutput, body.fps, media.codec as 'h264' | 'vp8',
                resolveH264TargetBitrate({ ...outputSize, fps: body.fps }));
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
