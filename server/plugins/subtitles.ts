import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { resolveUploadFile, uploadDir } from '../media-dir.ts';

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

interface SubtitleRequest {
  format?: 'srt' | 'txt';
  name?: string;
  cues?: SubtitleCue[];
}

async function readJson(req: IncomingMessage): Promise<SubtitleRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 2_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as SubtitleRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function timestamp(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function serialize(cues: SubtitleCue[], format: 'srt' | 'txt'): string {
  if (format === 'txt') return `${cues.map((cue) => cue.text).join('\n')}\n`;
  return `\uFEFF${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}

function validate(input: SubtitleRequest): { format: 'srt' | 'txt'; name: string; cues: SubtitleCue[] } {
  const format = input.format ?? 'srt';
  if (format !== 'srt' && format !== 'txt') throw new Error('subtitle format must be srt or txt');
  if (!Array.isArray(input.cues) || !input.cues.length) throw new Error('the timeline has no captions to export');
  if (input.cues.length > 10_000) throw new Error('too many subtitle cues');
  const cues = input.cues.map((cue) => {
    const start = Number(cue.start);
    const end = Number(cue.end);
    const text = String(cue.text ?? '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text) throw new Error('invalid subtitle cue');
    return { start, end, text };
  });
  const stem = String(input.name ?? 'subtitles').replace(/\.(srt|txt)$/i, '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim() || 'subtitles';
  return { format, name: `${stem}.${format}`, cues };
}

export function subtitleExportPlugin(): Plugin {
  return {
    name: 'openchatcut-subtitle-export',
    configureServer(server) {
      server.middlewares.use('/generate/subtitles', async (req, res) => {
        if (req.method === 'GET') {
          const requestUrl = new URL(req.url ?? '/', 'http://localhost');
          const match = requestUrl.pathname.match(/^\/file\/([a-f0-9-]+\.(srt|txt))$/i);
          if (!match) { sendJson(res, 404, { error: 'subtitle file not found' }); return; }
          try {
            const file = resolveUploadFile(match[1]);
            if (!file) { sendJson(res, 404, { error: 'subtitle file not found' }); return; }
            const bytes = await readFile(file);
            const requestedName = requestUrl.searchParams.get('name') ?? match[1];
            const downloadName = requestedName.replace(/[\r\n"\\/]+/g, '_');
            res.statusCode = 200;
            res.setHeader('Content-Type', match[2] === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="subtitles.${match[2]}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
            res.end(bytes);
          } catch {
            sendJson(res, 404, { error: 'subtitle file not found' });
          }
          return;
        }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validate(await readJson(req));
          const dir = uploadDir();
          await mkdir(dir, { recursive: true });
          const filename = `${randomUUID()}.${input.format}`;
          const path = `/media/uploads/${filename}`;
          const downloadUrl = `/generate/subtitles/file/${filename}?name=${encodeURIComponent(input.name)}`;
          await writeFile(resolve(dir, filename), serialize(input.cues, input.format), 'utf8');
          sendJson(res, 200, { status: 'completed', path, downloadUrl, name: input.name, format: input.format, cueCount: input.cues.length });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[export:subtitles] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
