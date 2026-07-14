import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, mkdir, stat } from 'node:fs/promises';
import { normalizeFrameRange } from './src/export/range.ts';
import { createGenerationJob, getGenerationJobSnapshot } from './vite-generation-jobs.ts';
// @ts-expect-error — plain .mjs render pipeline shared with scripts/export.mjs (no .d.ts)
import { renderTimeline, renderTimelineStills, renderClip } from './remotion/render.mjs';

const UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');
const CLIP_EXT: Record<string, string> = { prores: 'mov', vp8: 'webm', vp9: 'webm', h264: 'mp4' };
const CLIP_MIME: Record<string, string> = { mov: 'video/quicktime', webm: 'video/webm', mp4: 'video/mp4' };

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB — timelines carry inlined template code.

type ExportRequest = {
  state?: unknown;
  format?: 'video' | 'audio';
  codec?: 'h264' | 'vp8' | 'mp3' | 'wav';
  name?: string;
  startFrame?: number;
  endFrameExclusive?: number;
  startSeconds?: number;
  endSeconds?: number;
};

type ExportTimeline = {
  fps: number;
  items: Array<{ startFrame: number; durationInFrames: number }>;
};

const EXPORT_MEDIA = {
  h264: { codec: 'h264', ext: 'mp4', mime: 'video/mp4' },
  vp8: { codec: 'vp8', ext: 'webm', mime: 'video/webm' },
  mp3: { codec: 'mp3', ext: 'mp3', mime: 'audio/mpeg' },
  wav: { codec: 'wav', ext: 'wav', mime: 'audio/wav' },
} as const;

function exportFilename(name: string | undefined, ext: string): string {
  // 只滤真正非法的文件系统字符，保留中文等 Unicode（原来的 [^\w.-] 会把中文全砍成下划线）。
  const base = (name ?? 'export').replace(/\.(?:mp4|webm|mp3|wav)$/i, '').replace(/[/\\:*?"<>|\x00-\x1f]+/g, '_').trim() || 'export';
  return `${base}.${ext}`;
}

// RFC 5987：filename= 是 latin-1 字段，中文 UTF-8 字节直接塞进去会被浏览器按 latin-1
// 解码成乱码。给一个 ASCII 兜底 filename= + filename*=UTF-8'' 百分号编码（对标 vite-plugin-subtitles）。
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function exportDuration(state: ExportTimeline): number {
  return Math.max(
    state.fps,
    state.items.reduce((end, item) => Math.max(end, item.startFrame + item.durationInFrames), 0),
  );
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

/** 请求体校验失败（→ 400）。渲染本身的失败发生在 job 里，不走这条。 */
class ExportRequestError extends Error {}

interface ExportPlan {
  state: unknown;
  format: 'video' | 'audio';
  media: (typeof EXPORT_MEDIA)[keyof typeof EXPORT_MEDIA];
  frameRange: [number, number] | undefined;
  filename: string;
  durationSeconds: number;
}

// 与同步 /export 完全相同的入参校验 + 帧范围推导，抽成纯函数供异步 /export/job 复用。
// （刻意不改同步 /export 的内联逻辑——保持它 100% 不变，代价是这段校验有少量重复。）
function planExport(body: ExportRequest | null): ExportPlan {
  const state = body?.state;
  if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
    throw new ExportRequestError('body must be { state: TimelineState } with an items array');
  }
  const fps = (state as ExportTimeline).fps;
  if (!Number.isFinite(fps) || fps <= 0) throw new ExportRequestError('state.fps must be a positive number');
  if (body?.format !== undefined && body.format !== 'video' && body.format !== 'audio') {
    throw new ExportRequestError('format must be video or audio');
  }
  if (body?.codec !== undefined && !['h264', 'vp8', 'mp3', 'wav'].includes(body.codec)) {
    throw new ExportRequestError('codec must be h264, vp8, mp3, or wav');
  }
  if (body?.name !== undefined && typeof body.name !== 'string') throw new ExportRequestError('name must be a string');
  if ([body?.startSeconds, body?.endSeconds].some((value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new ExportRequestError('startSeconds and endSeconds must be finite numbers');
  }
  const format = body?.format ?? 'video';
  const codec = body?.codec ?? (format === 'audio' ? 'mp3' : 'h264');
  if ((format === 'audio') !== (codec === 'mp3' || codec === 'wav')) {
    throw new ExportRequestError(`${format} export does not support codec=${codec}`);
  }
  const media = EXPORT_MEDIA[codec];
  const startFrame = body?.startFrame ?? (body?.startSeconds === undefined ? undefined : Math.floor(body.startSeconds * fps));
  const endFrameExclusive = body?.endFrameExclusive ?? (body?.endSeconds === undefined ? undefined : Math.ceil(body.endSeconds * fps));
  const totalFrames = exportDuration(state as ExportTimeline);
  const frameRange = normalizeFrameRange(totalFrames, startFrame, endFrameExclusive);
  const frames = frameRange ? frameRange[1] - frameRange[0] + 1 : totalFrames;
  return { state, format, media, frameRange, filename: exportFilename(body?.name, media.ext), durationSeconds: frames / fps };
}

/**
 * Dev-server plugin exposing `POST /export`: body `{ state, format?, ... }` →
 * rendered MP4/WebM/MP3/WAV. Mirrors the CLI export and ChatCut's server-side
 * render — the timeline is rendered in headless Chrome.
 */
export function exportPlugin(): Plugin {
  return {
    name: 'chatcut-export',
    configureServer(server) {
      // POST /render-still { state, frames:[n] } → { frames: [{frame, base64}] }
      // (source view_timeline_frames: the agent renders stills to "see" its edits)
      server.middlewares.use('/render-still', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }
        try {
          const body = (await readJsonBody(req)) as { state?: unknown; frames?: unknown } | null;
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
          const rendered = await renderTimelineStills({ state, frames });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ frames: rendered }));
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
            await mkdir(UPLOAD_DIR, { recursive: true });
            const fname = `${randomUUID()}.${ext}`;
            await renderClip({ state, outputLocation: join(UPLOAD_DIR, fname), codec, transparent });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path: `/media/uploads/${fname}` }));
          } else {
            tmpOut = join(tmpdir(), `chatcut-clip-${randomUUID()}.${ext}`);
            await renderClip({ state, outputLocation: tmpOut, codec, transparent });
            const buf = await readFile(tmpOut);
            const safe = (body?.filename ?? 'clip').replace(/[/\\:*?"<>|\x00-\x1f]+/g, '_').trim() || 'clip';
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
          if (tmpOut) unlink(tmpOut).catch(() => {});
        }
      });

      // 异步渲染 job（对标源站 submit_export 视频/音频异步语义 + track_export 轮询）：
      //   POST /export/job     → 入队渲染，立即返回 { renderId }（真正的渲染在后台队列跑）。
      //   GET  /export/job/:id → 返回 job 快照（status/progress/result/error），未知 → 404。
      // 必须注册在 /export 之前：connect 前缀匹配下 '/export' 也会命中 '/export/job'，先注册先执行。
      // 渲染产物落 public/media/uploads/<uuid>.<ext>，浏览器完成后按 result.path 直接取。
      server.middlewares.use('/export/job', async (req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        const id = path.replace(/^\/+|\/+$/g, '');

        if (req.method === 'GET') {
          if (!id) { sendError(res, 400, 'render id is required'); return; }
          const snapshot = getGenerationJobSnapshot(id);
          if (!snapshot) { sendError(res, 404, `render job ${id} not found`); return; }
          sendJson(res, 200, snapshot);
          return;
        }
        if (req.method !== 'POST') { sendError(res, 405, 'method not allowed — POST to enqueue, GET to inspect'); return; }
        if (id) { sendError(res, 404, 'unknown export job route'); return; }

        try {
          const body = (await readJsonBody(req)) as ExportRequest | null;
          const plan = planExport(body);
          const uuid = randomUUID();
          const filepath = join(UPLOAD_DIR, `${uuid}.${plan.media.ext}`);
          const publicPath = `/media/uploads/${uuid}.${plan.media.ext}`;
          const { jobId } = createGenerationJob(
            { kind: 'export', format: plan.format, codec: plan.media.codec, name: plan.filename, frameRange: plan.frameRange ?? null },
            async () => {
              await mkdir(UPLOAD_DIR, { recursive: true });
              await renderTimeline({ state: plan.state, outputLocation: filepath, codec: plan.media.codec, frameRange: plan.frameRange });
              const { size } = await stat(filepath);
              return { assetId: uuid, kind: plan.format, name: plan.filename, path: publicPath, durationSeconds: plan.durationSeconds, sizeBytes: size, codec: plan.media.codec };
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
          const media = EXPORT_MEDIA[codec];
          const startFrame = body.startFrame ?? (body.startSeconds === undefined ? undefined : Math.floor(body.startSeconds * fps));
          const endFrameExclusive = body.endFrameExclusive ?? (body.endSeconds === undefined ? undefined : Math.ceil(body.endSeconds * fps));
          const frameRange = normalizeFrameRange(
            exportDuration(state as ExportTimeline),
            startFrame,
            endFrameExclusive,
          );
          const filename = exportFilename(body.name, media.ext);

          outputLocation = join(tmpdir(), `chatcut-export-${randomUUID()}.${media.ext}`);
          await renderTimeline({ state, outputLocation, codec: media.codec, frameRange });

          const buf = await readFile(outputLocation);
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
          if (outputLocation) unlink(outputLocation).catch(() => {});
        }
      });
    },
  };
}
