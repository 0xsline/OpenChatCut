import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { normalizeFrameRange } from './src/export/range.ts';
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
