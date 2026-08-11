import { randomUUID } from 'node:crypto';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { exportFailureFrom } from '../../src/export/exportFailure.ts';
import { sanitizeFileName } from '../file-name.ts';
import { formatFrameLabel, tileContactSheet } from '../frame-grid.ts';
import { uploadDir } from '../media-dir.ts';
import type { ExportPlan } from './export-plan.ts';
import { acceptExportSubmission } from './export-submission.ts';
import { withExportPermit } from './export-runtime.ts';
import {
  bindRequestAbort,
  contentDisposition,
  readJsonBody,
  sendError,
  sendExportFailure,
  sendSequenceGraphFailure,
} from './export-http.ts';
import {
  h264RenderOptions,
  renderClip,
  renderTimelineStills,
} from './export-rendering.ts';

const CLIP_EXT: Record<string, string> = { prores: 'mov', vp8: 'webm', vp9: 'webm', h264: 'mp4' };
const CLIP_MIME: Record<string, string> = { mov: 'video/quicktime', webm: 'video/webm', mp4: 'video/mp4' };

export function registerRenderStillRoute(server: ViteDevServer): void {
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
    const requestAbort = bindRequestAbort(req, res);
    try {
      const body = (await readJsonBody(req)) as {
        state?: unknown;
        project?: unknown;
        timelineId?: unknown;
        frames?: unknown;
        grid?: boolean;
        fps?: number;
      } | null;
      requestAbort.controller.signal.throwIfAborted();
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
        }, { signal: requestAbort.controller.signal });
        plan = accepted.plan;
        cleanupRenderMedia = accepted.cleanup;
      } catch (error) {
        if (requestAbort.controller.signal.aborted) throw error;
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
        signal: requestAbort.controller.signal,
      }) as Array<{ frame: number; base64: string }>;
      const fps = typeof body?.fps === 'number' && body.fps > 0 ? body.fps : plan.state.fps;
      const wantGrid = body?.grid !== false && rendered.length >= 2;
      let gridBase64: string | undefined;
      if (wantGrid) {
        try {
          const sheet = await tileContactSheet(
            rendered.map((renderedFrame) => ({
              jpeg: Buffer.from(renderedFrame.base64, 'base64'),
              label: formatFrameLabel(renderedFrame.frame, fps),
            })),
            { cellWidth: rendered.length > 9 ? 280 : 320 },
          );
          requestAbort.controller.signal.throwIfAborted();
          gridBase64 = sheet.toString('base64');
        } catch (gridError) {
          server.config.logger.info(
            `[render-still] grid tile failed, falling back to multi-image: ${gridError instanceof Error ? gridError.message : String(gridError)}`,
          );
        }
      }
      requestAbort.controller.signal.throwIfAborted();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        frames: rendered,
        gridBase64,
        renderedBy: 'remotion',
      }));
    } catch (error) {
      if (requestAbort.controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      server.config.logger.error(`[render-still] ${message}`);
      if (!res.headersSent) sendError(res, 500, message);
      else res.end();
    } finally {
      await cleanupRenderMedia?.();
      requestAbort.dispose();
    }
  });
}

export function registerRenderClipRoute(server: ViteDevServer): void {
  server.middlewares.use('/render-clip', async (req, res) => {
    if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — use POST'); return; }
    let tmpOut: string | null = null;
    let bakeOut: string | null = null;
    let cleanupRenderMedia: (() => Promise<void>) | undefined;
    const requestAbort = bindRequestAbort(req, res);
    try {
      const body = (await readJsonBody(req)) as { state?: unknown; codec?: string; transparent?: boolean; mode?: string; filename?: string } | null;
      requestAbort.controller.signal.throwIfAborted();
      const state = body?.state;
      if (!state || typeof state !== 'object' || !('items' in state) || !Array.isArray(state.items)) {
        sendError(res, 400, 'body must be { state, codec, mode }'); return;
      }
      const codec = typeof body?.codec === 'string' && body.codec in CLIP_EXT ? body.codec : 'h264';
      const accepted = await acceptExportSubmission(
        { state },
        { signal: requestAbort.controller.signal },
      );
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
          signal: requestAbort.controller.signal,
        }), requestAbort.controller.signal);
        requestAbort.controller.signal.throwIfAborted();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ path: `/media/uploads/${fname}` }));
        requestAbort.controller.signal.throwIfAborted();
        bakeOut = null;
      } else {
        tmpOut = join(tmpdir(), `openchatcut-clip-${randomUUID()}.${ext}`);
        await withExportPermit(async () => renderClip({
          state: renderState,
          outputLocation: tmpOut,
          codec,
          transparent,
          ...await h264RenderOptions(codec),
          signal: requestAbort.controller.signal,
        }), requestAbort.controller.signal);
        requestAbort.controller.signal.throwIfAborted();
        const buffer = await readFile(tmpOut, { signal: requestAbort.controller.signal });
        requestAbort.controller.signal.throwIfAborted();
        const safe = sanitizeFileName(body?.filename ?? 'clip', 'clip');
        res.statusCode = 200;
        res.setHeader('Content-Type', CLIP_MIME[ext] ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Content-Disposition', contentDisposition(`${safe}.${ext}`));
        res.end(buffer);
      }
    } catch (error) {
      if (requestAbort.controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      server.config.logger.error(`[render-clip] ${message}`);
      const failure = exportFailureFrom(error);
      if (!res.headersSent) {
        if (failure) sendExportFailure(res, failure.stage === 'preflight' ? 422 : 500, failure);
        else sendError(res, 500, message);
      } else res.end();
    } finally {
      if (tmpOut) await unlink(tmpOut).catch(() => {});
      if (bakeOut) await unlink(bakeOut).catch(() => {});
      await cleanupRenderMedia?.();
      requestAbort.dispose();
    }
  });
}
