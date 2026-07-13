import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
// @ts-expect-error — plain .mjs render pipeline shared with scripts/export.mjs (no .d.ts)
import { renderTimeline, renderTimelineStills } from './remotion/render.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB — timelines carry inlined template code.

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
 * Dev-server plugin exposing `POST /export`: body `{ state }` → rendered MP4
 * streamed back as video/mp4. Mirrors the CLI export (scripts/export.mjs) and
 * ChatCut's server-side render — the timeline is rendered in headless Chrome.
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

      server.middlewares.use('/export', async (req, res) => {
        if (req.method !== 'POST') {
          sendError(res, 405, 'method not allowed — use POST');
          return;
        }

        let outputLocation: string | null = null;
        try {
          const body = await readJsonBody(req);
          const state = (body as { state?: unknown } | null)?.state;
          if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
            sendError(res, 400, 'body must be { state: TimelineState } with an items array');
            return;
          }

          outputLocation = join(tmpdir(), `chatcut-export-${randomUUID()}.mp4`);
          await renderTimeline({ state, outputLocation });

          const buf = await readFile(outputLocation);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Length', String(buf.length));
          res.setHeader('Content-Disposition', 'attachment; filename="export.mp4"');
          res.end(buf);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[export] ${message}`);
          if (!res.headersSent) sendError(res, 500, message);
          else res.end();
        } finally {
          if (outputLocation) unlink(outputLocation).catch(() => {});
        }
      });
    },
  };
}
