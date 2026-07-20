// POST /api/extract-audio — pull a low-bitrate audio track from a local
// /media/uploads video (or large audio) for ASR. Avoids fetching a multi-GB
// master into the browser just to re-upload it to AssemblyAI.
//
// Extracts a compact 64k Opus track before processing the main media bytes.
// Runs on demand at transcription time; caches `<stem>.asr.ogg` (or .mp3).
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';

const MAX_JSON = 8 * 1024;
const ASR_BITRATE = '64k';
const FFMPEG_TIMEOUT_MS = 30 * 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max = MAX_JSON): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** `/media/uploads/foo.mp4` → `foo.mp4` or null if unsafe. */
function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const m = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!m) return null;
  return isSafeUploadName(m[1]) ? m[1] : null;
}

function asrStem(sourceName: string): string {
  const stem = sourceName.replace(/\.[^.]+$/, '') || sourceName;
  return stem.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]+/g, '_').slice(0, 80) || 'media';
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr?.on('data', (c: Buffer) => {
      stderr += String(c);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function tryEncode(
  inputPath: string,
  finalPath: string,
  codecArgs: string[],
): Promise<number> {
  // Keep a real media extension on the temp file — ffmpeg picks muxer from
  // suffix (`*.ogg.tmp` / `*.ogg.part` would be treated as unknown).
  const partPath = finalPath.replace(/(\.(ogg|mp3))$/i, '.tmp$1');
  await unlink(partPath).catch(() => {});
  await runFfmpeg(
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-vn',
      '-map', '0:a:0?',
      ...codecArgs,
      partPath,
    ],
    FFMPEG_TIMEOUT_MS,
  );
  await rename(partPath, finalPath);
  return (await stat(finalPath)).size;
}

/** Returns absolute path of written ASR audio. */
async function extractAsrAudio(inputPath: string, dir: string, stem: string): Promise<{ file: string; bytes: number }> {
  const oggPath = join(dir, `${stem}.asr.ogg`);
  try {
    const bytes = await tryEncode(inputPath, oggPath, [
      '-c:a', 'libopus', '-b:a', ASR_BITRATE, '-ac', '1', '-ar', '16000',
    ]);
    return { file: oggPath, bytes };
  } catch (opusErr) {
    await unlink(oggPath).catch(() => {});
    await unlink(`${oggPath}.part`).catch(() => {});
    const mp3Path = join(dir, `${stem}.asr.mp3`);
    try {
      const bytes = await tryEncode(inputPath, mp3Path, [
        '-c:a', 'libmp3lame', '-b:a', ASR_BITRATE, '-ac', '1', '-ar', '16000',
      ]);
      return { file: mp3Path, bytes };
    } catch {
      await unlink(mp3Path).catch(() => {});
      await unlink(`${mp3Path}.part`).catch(() => {});
      throw opusErr;
    }
  }
}

export function extractAudioPlugin(): Plugin {
  return {
    name: 'openchatcut-extract-audio',
    configureServer(server) {
      server.middlewares.use('/api/extract-audio', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJson(req)) as { src?: string; force?: boolean };
          const src = String(body.src ?? '').trim();
          const name = uploadNameFromSrc(src);
          if (!name) {
            sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
            return;
          }
          const inputPath = resolveUploadFile(name);
          if (!inputPath) {
            sendJson(res, 404, { error: `media not found: ${name}` });
            return;
          }

          const stem = asrStem(name);
          const dir = uploadDir();
          const force = body.force === true;
          if (!force) {
            for (const candidate of [`${stem}.asr.ogg`, `${stem}.asr.mp3`]) {
              const full = join(dir, candidate);
              if (!existsSync(full)) continue;
              try {
                const info = await stat(full);
                if (info.isFile() && info.size > 0) {
                  sendJson(res, 200, {
                    ok: true,
                    path: `/media/uploads/${candidate}`,
                    bytes: info.size,
                    cached: true,
                    source: src,
                  });
                  return;
                }
              } catch { /* continue */ }
            }
          }

          const { file, bytes } = await extractAsrAudio(inputPath, dir, stem);
          if (bytes <= 0) {
            sendJson(res, 422, { error: 'extracted audio is empty (source may have no audio track)' });
            return;
          }
          const outName = basename(file);
          server.config.logger.info(`[extract-audio] ${name} → ${outName} (${bytes} bytes)`);
          sendJson(res, 200, {
            ok: true,
            path: `/media/uploads/${outName}`,
            bytes,
            cached: false,
            source: src,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[extract-audio] ${message}`);
          const status = /ENOENT|spawn ffmpeg/i.test(message) ? 503
            : /no audio|empty|exit/i.test(message) ? 422
              : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
