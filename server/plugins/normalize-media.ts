// POST /api/normalize-media — conditional video re-encode for local masters.
// Uses a ≤1920px long edge, browser-friendly codecs, and an ~8Mbps cap.
// Runs *after* stream upload so large files never sit in RAM.
// Skips when source is already efficient. Replaces bytes under the same /media/uploads
// path when possible; if container must become mp4, returns a new path and deletes the old.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { putUploadFile, r2Config } from '../r2.ts';

const MAX_JSON = 8 * 1024;
const MAX_DIMENSION = 1920;
const SKIP_MAX_SOURCE_BITRATE_BPS = 8_000_000;
const TARGET_PEAK_BITRATE_BPS = 8_000_000;
const TARGET_FLOOR_BITRATE_BPS = 1_500_000;
const REFERENCE_PIXELS = 1920 * 1080;
const VIDEO_AUDIO_BITRATE = '160k';
const FFMPEG_TIMEOUT_MS = 60 * 60_000; // long masters

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

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const m = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!m) return null;
  return isSafeUploadName(m[1]) ? m[1] : null;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += String(c);
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += String(c);
      if (stderr.length > 16_000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}

interface ProbeMeta {
  width: number;
  height: number;
  duration: number;
  videoCodec: string;
  audioCodec: string;
  hasAudio: boolean;
  sourceBitrate: number;
  size: number;
}

async function probeVideo(path: string): Promise<ProbeMeta> {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate,size:stream=index,codec_type,codec_name,width,height,bit_rate,avg_frame_rate,r_frame_rate',
      '-of', 'json',
      path,
    ],
    30_000,
  );
  const data = JSON.parse(stdout || '{}') as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string; bit_rate?: string; size?: string };
  };
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('no video stream');
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const duration = Number(data.format?.duration) || 0;
  const size = Number(data.format?.size) || (await stat(path)).size;
  let sourceBitrate = Number(video.bit_rate) || Number(data.format?.bit_rate) || 0;
  if (!sourceBitrate && duration > 0) sourceBitrate = Math.floor((size * 8) / duration);
  return {
    width,
    height,
    duration,
    videoCodec: String(video.codec_name || ''),
    audioCodec: String(audio?.codec_name || ''),
    hasAudio: Boolean(audio?.codec_name),
    sourceBitrate,
    size,
  };
}

function compatibleVideoCodec(codec: string): boolean {
  return ['h264', 'avc', 'avc1', 'vp8', 'vp9', 'av1'].includes(codec.toLowerCase());
}

function compatibleAudioCodec(codec: string): boolean {
  if (!codec) return true;
  return ['aac', 'flac', 'mp3', 'mp4a', 'opus', 'vorbis'].includes(codec.toLowerCase());
}

function targetDimension(width: number, height: number): { w: number; h: number } {
  const longest = Math.max(width, height);
  let w = width;
  let h = height;
  if (longest > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / longest;
    w = Math.round(width * scale);
    h = Math.round(height * scale);
  }
  if (w % 2) w += 1;
  if (h % 2) h += 1;
  return { w: Math.max(2, w), h: Math.max(2, h) };
}

function recommendedBitrate(width: number, height: number): number {
  const scaled = TARGET_PEAK_BITRATE_BPS * ((width * height) / REFERENCE_PIXELS);
  const clamped = Math.min(TARGET_PEAK_BITRATE_BPS, Math.max(TARGET_FLOOR_BITRATE_BPS, scaled));
  return Math.ceil(clamped / 1000) * 1000;
}

function normalizeReason(meta: ProbeMeta, targetBitrate: number): string | null {
  if (!compatibleVideoCodec(meta.videoCodec)) {
    return `video codec ${meta.videoCodec || 'unknown'} is not browser-aligned`;
  }
  if (meta.hasAudio && !compatibleAudioCodec(meta.audioCodec)) {
    return `audio codec ${meta.audioCodec || 'unknown'} is not browser-aligned`;
  }
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    return `dimensions ${meta.width}x${meta.height} exceed ${MAX_DIMENSION}px`;
  }
  if (meta.sourceBitrate > 0) {
    const efficient = Math.max(targetBitrate * 1.15, SKIP_MAX_SOURCE_BITRATE_BPS);
    if (meta.sourceBitrate > efficient) return 'source bitrate exceeds efficient threshold';
  }
  // Very large files even if "compatible" (e.g. long 1080p high quality) — soft cap ~1.5GB
  if (meta.size > 1.5 * 1024 * 1024 * 1024) return 'source file larger than 1.5GB';
  return null;
}

async function encodeNormalized(
  inputPath: string,
  outputPath: string,
  meta: ProbeMeta,
  targetW: number,
  targetH: number,
  targetBitrate: number,
): Promise<void> {
  const vf = `scale=${targetW}:${targetH}:flags=lanczos`;
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    ...(meta.hasAudio ? ['-map', '0:a:0?'] : ['-an']),
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-b:v', String(targetBitrate),
    '-maxrate', String(targetBitrate),
    '-bufsize', String(targetBitrate * 2),
    '-movflags', '+faststart',
  ];
  if (meta.hasAudio) args.push('-c:a', 'aac', '-b:a', VIDEO_AUDIO_BITRATE);
  args.push(outputPath);
  await run('ffmpeg', args, FFMPEG_TIMEOUT_MS);
}

export function normalizeMediaPlugin(): Plugin {
  return {
    name: 'openchatcut-normalize-media',
    configureServer(server) {
      server.middlewares.use('/api/normalize-media', async (req, res) => {
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

          const ext = extname(name).toLowerCase();
          // Images / pure audio / already-asr: no-op
          if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.asr.ogg', '.cube', '.json'].some((e) => name.endsWith(e))
            || name.includes('.asr.')) {
            sendJson(res, 200, { ok: true, path: src, normalized: false, reason: 'not a video master' });
            return;
          }
          // Treat unknown/binary as maybe video only when common video ext
          const videoExt = ['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi', '.mpeg', '.mpg'].includes(ext);
          if (!videoExt && !body.force) {
            sendJson(res, 200, { ok: true, path: src, normalized: false, reason: 'skip non-video extension' });
            return;
          }

          let meta: ProbeMeta;
          try {
            meta = await probeVideo(inputPath);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Not a video / no stream — soft skip so import still works
            sendJson(res, 200, { ok: true, path: src, normalized: false, reason: `probe skipped: ${message}` });
            return;
          }

          const { w: targetW, h: targetH } = targetDimension(meta.width, meta.height);
          const targetBitrate = recommendedBitrate(targetW, targetH);
          const reason = body.force ? 'force' : normalizeReason(meta, targetBitrate);
          if (!reason) {
            sendJson(res, 200, {
              ok: true,
              path: src,
              normalized: false,
              reason: 'source accepted',
              bytes: meta.size,
              width: meta.width,
              height: meta.height,
              durationSeconds: meta.duration || undefined,
            });
            return;
          }

          const dir = dirname(inputPath);
          const stem = basename(name, extname(name));
          // Always land on .mp4 for browser + remotion friendliness
          const outName = `${stem}.mp4`;
          const outPath = join(dir === uploadDir() ? uploadDir() : dir, outName);
          const tmpPath = join(dirname(outPath), `${stem}.norm.tmp.mp4`);
          await unlink(tmpPath).catch(() => {});

          server.config.logger.info(`[normalize-media] ${name}: ${reason}`);
          await encodeNormalized(inputPath, tmpPath, meta, targetW, targetH, targetBitrate);

          // Publish: if same path, atomic replace; if new .mp4 name, swap and drop old
          if (outPath === inputPath || basename(outPath) === name) {
            const bak = `${inputPath}.bak-norm`;
            await unlink(bak).catch(() => {});
            await rename(inputPath, bak);
            try {
              await rename(tmpPath, inputPath);
              await unlink(bak).catch(() => {});
            } catch (err) {
              await rename(bak, inputPath).catch(() => {});
              throw err;
            }
          } else {
            await unlink(outPath).catch(() => {});
            await rename(tmpPath, outPath);
            if (existsSync(inputPath) && inputPath !== outPath) {
              await unlink(inputPath).catch(() => {});
            }
          }

          const finalPath = existsSync(outPath) ? outPath : inputPath;
          const finalName = basename(finalPath);
          const finalSrc = `/media/uploads/${finalName}`;
          const bytes = (await stat(finalPath)).size;

          // Refresh R2 object if cloud write-through is on
          if (r2Config()) {
            try {
              await putUploadFile(finalName, finalPath, 'video/mp4');
            } catch (err) {
              server.config.logger.error(`[normalize-media→R2] ${finalName}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Drop stale ASR cache for the old master (new extract on next transcribe)
          for (const stale of [`${stem}.asr.ogg`, `${stem}.asr.mp3`]) {
            await unlink(join(uploadDir(), stale)).catch(() => {});
          }

          server.config.logger.info(`[normalize-media] ${name} → ${finalName} (${meta.size} → ${bytes} bytes)`);
          sendJson(res, 200, {
            ok: true,
            path: finalSrc,
            normalized: true,
            reason,
            bytes,
            bytesBefore: meta.size,
            width: targetW,
            height: targetH,
            durationSeconds: meta.duration || undefined,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[normalize-media] ${message}`);
          const status = /ENOENT|spawn ffmpeg|spawn ffprobe/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
