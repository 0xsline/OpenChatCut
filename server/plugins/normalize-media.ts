// POST /api/normalize-media — compatibility normalization with opt-in media optimization.
// Compatibility-only conversions preserve source dimensions and bitrate. optimize:true
// also applies the existing dimension, bitrate, and file-size thresholds.
// Runs after stream upload so large files never sit in RAM.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import {
  h264EncoderAttempts,
  h264EncodingArgs,
  isHardwareH264Encoder,
  probeEncoderQualityMode,
  resolveH264Encoder,
  resolveHwDecodeArgs,
} from '../media-acceleration.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { putUploadFile, r2Config } from '../r2.ts';

const MAX_JSON = 8 * 1024;
const MAX_DIMENSION = 1920;
const SKIP_MAX_SOURCE_BITRATE_BPS = 8_000_000;
const TARGET_PEAK_BITRATE_BPS = 8_000_000;
const TARGET_FLOOR_BITRATE_BPS = 1_500_000;
const REFERENCE_PIXELS = 1920 * 1080;
const VIDEO_AUDIO_BITRATE = '160k';
const FFMPEG_TIMEOUT_MS = 60 * 60_000; // long masters

export const NORMALIZE_CONCURRENCY = 2;
export const NORMALIZE_MAX_QUEUED = 8;

export type ReleaseNormalizePermit = () => void;

export interface NormalizeAdmission {
  acquire: (key: string) => Promise<ReleaseNormalizePermit>;
  snapshot: () => { active: number; queued: number };
}

interface WaitingNormalizePermit {
  key: string;
  resolve: (release: ReleaseNormalizePermit) => void;
}

export class NormalizeAdmissionFullError extends Error {
  constructor() {
    super('media normalization queue is full');
    this.name = 'NormalizeAdmissionFullError';
  }
}

export function createNormalizeAdmission(
  concurrency = NORMALIZE_CONCURRENCY,
  maxQueued = NORMALIZE_MAX_QUEUED,
): NormalizeAdmission {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('normalize concurrency must be a positive integer');
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new RangeError('normalize queue limit must be a non-negative integer');
  }

  let active = 0;
  const activeKeys = new Set<string>();
  const waiting: WaitingNormalizePermit[] = [];

  function drain(): void {
    while (active < concurrency) {
      const nextIndex = waiting.findIndex(({ key }) => !activeKeys.has(key));
      if (nextIndex < 0) return;
      const [next] = waiting.splice(nextIndex, 1);
      active += 1;
      activeKeys.add(next.key);
      next.resolve(releaseOnce(next.key));
    }
  }

  function releaseOnce(key: string): ReleaseNormalizePermit {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      activeKeys.delete(key);
      drain();
    };
  }

  return {
    acquire(key) {
      if (active < concurrency && !activeKeys.has(key)) {
        active += 1;
        activeKeys.add(key);
        return Promise.resolve(releaseOnce(key));
      }
      if (waiting.length >= maxQueued) {
        return Promise.reject(new NormalizeAdmissionFullError());
      }
      const { promise, resolve } = Promise.withResolvers<ReleaseNormalizePermit>();
      waiting.push({ key, resolve });
      return promise;
    },
    snapshot: () => ({ active, queued: waiting.length }),
  };
}

export function createNormalizeTempPath(
  outputPath: string,
  createId: () => string = randomUUID,
): string {
  const outputName = basename(outputPath, extname(outputPath));
  return join(dirname(outputPath), `.${outputName}.norm-${createId()}.tmp.mp4`);
}

export function resolveNormalizeOutputPath(inputPath: string): string {
  const inputName = basename(inputPath);
  const stem = basename(inputName, extname(inputName));
  return join(dirname(inputPath), `${stem}.mp4`);
}

type ResolveRealpath = (path: string) => Promise<string>;

function normalizeFilesystemIdentity(path: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin' || platform === 'win32') {
    return path.normalize('NFC').toLowerCase();
  }
  return path;
}

export async function resolveNormalizeTargetKey(
  outputPath: string,
  platform: NodeJS.Platform = process.platform,
  resolveRealpath: ResolveRealpath = realpath,
): Promise<string> {
  let targetIdentity: string;
  try {
    targetIdentity = await resolveRealpath(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parentIdentity = await resolveRealpath(dirname(outputPath));
    targetIdentity = join(parentIdentity, basename(outputPath));
  }
  return normalizeFilesystemIdentity(targetIdentity, platform);
}

const normalizeAdmission = createNormalizeAdmission();

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
    let settled = false;
    let timeoutError: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      timeoutError = new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += String(c);
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += String(c);
      if (stderr.length > 16_000) stderr = stderr.slice(-8000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(timeoutError ?? (code === 0
      ? undefined
      : new Error(`${cmd} exit ${code}: ${stderr.slice(-600)}`))));
  });
}

export interface ProbeMeta {
  width: number;
  height: number;
  duration: number;
  videoCodec: string;
  audioCodec: string;
  hasAudio: boolean;
  sourceBitrate: number;
  size: number;
  avgFrameRate?: number;
  nominalFrameRate?: number;
  frameCount?: number;
  variableFrameRate: boolean;
}

export function parseFrameRate(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'N/A') return undefined;
  const [numeratorRaw, denominatorRaw] = raw.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = denominatorRaw === undefined ? 1 : Number(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

export function isVariableFrameRate(avgFrameRate?: number, nominalFrameRate?: number): boolean {
  if (!avgFrameRate || !nominalFrameRate) return false;
  const reference = Math.max(avgFrameRate, nominalFrameRate);
  // A 0.05% relative tolerance ignores rational rounding noise while still
  // catching the common 30-tbr / drifting-average pattern from phone and
  // screen recordings.
  return Math.abs(avgFrameRate - nominalFrameRate) > Math.max(0.005, reference * 0.0005);
}

export function resolveTargetFps(
  requested: unknown,
  avgFrameRate?: number,
  nominalFrameRate?: number,
  allowRequested = false,
): number {
  const explicit = Number(requested);
  if (allowRequested && Number.isFinite(explicit) && explicit >= 1 && explicit <= 120) return explicit;
  const detected = avgFrameRate ?? nominalFrameRate;
  if (detected && Number.isFinite(detected)) return Math.max(1, Math.min(120, detected));
  return 30;
}

export function playableDurationSeconds(meta: Pick<ProbeMeta, 'duration' | 'frameCount' | 'avgFrameRate' | 'nominalFrameRate'>): number {
  const fps = meta.avgFrameRate ?? meta.nominalFrameRate;
  if (meta.frameCount && fps && Number.isFinite(fps) && fps > 0) {
    return meta.frameCount / fps;
  }
  return meta.duration;
}

async function probeVideo(path: string): Promise<ProbeMeta> {
  const { stdout } = await run(
    ffprobeBin(),
    [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate,size:stream=index,codec_type,codec_name,width,height,bit_rate,avg_frame_rate,r_frame_rate,nb_frames',
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
  if (width <= 0 || height <= 0) throw new Error('video stream has invalid dimensions');
  const duration = Number(data.format?.duration) || 0;
  const size = Number(data.format?.size) || (await stat(path)).size;
  let sourceBitrate = Number(video.bit_rate) || Number(data.format?.bit_rate) || 0;
  if (!sourceBitrate && duration > 0) sourceBitrate = Math.floor((size * 8) / duration);
  const avgFrameRate = parseFrameRate(video.avg_frame_rate);
  const nominalFrameRate = parseFrameRate(video.r_frame_rate);
  const parsedFrameCount = Number(video.nb_frames);
  const frameCount = Number.isInteger(parsedFrameCount) && parsedFrameCount > 0 ? parsedFrameCount : undefined;
  return {
    width,
    height,
    duration,
    videoCodec: String(video.codec_name || ''),
    audioCodec: String(audio?.codec_name || ''),
    hasAudio: Boolean(audio?.codec_name),
    sourceBitrate,
    size,
    avgFrameRate,
    nominalFrameRate,
    frameCount,
    variableFrameRate: isVariableFrameRate(avgFrameRate, nominalFrameRate),
  };
}

function compatibleVideoCodec(codec: string): boolean {
  return ['h264', 'avc', 'avc1', 'hevc', 'h265', 'hev1', 'hvc1', 'vp8', 'vp9', 'av1'].includes(codec.toLowerCase());
}

function compatibleAudioCodec(codec: string): boolean {
  if (!codec) return true;
  return ['aac', 'flac', 'mp3', 'mp4a', 'opus', 'vorbis'].includes(codec.toLowerCase());
}

export interface NormalizeStreamPlan {
  transcodeVideo: boolean;
  transcodeAudio: boolean;
}

export function resolveStreamPlan(
  meta: Pick<ProbeMeta, 'videoCodec' | 'audioCodec' | 'hasAudio'>,
  optimizeOutput: boolean,
  convertToCfr: boolean,
): NormalizeStreamPlan {
  return {
    transcodeVideo: optimizeOutput || convertToCfr || !compatibleVideoCodec(meta.videoCodec),
    transcodeAudio: meta.hasAudio && (optimizeOutput || !compatibleAudioCodec(meta.audioCodec)),
  };
}

function targetDimension(width: number, height: number, optimize: boolean): { w: number; h: number } {
  const longest = Math.max(width, height);
  let w = width;
  let h = height;
  if (optimize && longest > MAX_DIMENSION) {
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

function normalizeReason(
  meta: ProbeMeta,
  targetBitrate: number,
  forceCfr: boolean,
  optimize: boolean,
): string | null {
  if (forceCfr || meta.variableFrameRate) {
    const avg = meta.avgFrameRate?.toFixed(3) ?? 'unknown';
    const nominal = meta.nominalFrameRate?.toFixed(3) ?? 'unknown';
    return `variable frame rate detected (avg ${avg}, nominal ${nominal})`;
  }
  if (!compatibleVideoCodec(meta.videoCodec)) {
    return `video codec ${meta.videoCodec || 'unknown'} is not browser-aligned`;
  }
  if (meta.hasAudio && !compatibleAudioCodec(meta.audioCodec)) {
    return `audio codec ${meta.audioCodec || 'unknown'} is not browser-aligned`;
  }
  if (!optimize) return null;
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
  targetFps: number,
  convertToCfr: boolean,
  streamPlan: NormalizeStreamPlan,
): Promise<void> {
  const ffmpeg = ffmpegBin();
  const commonArgs = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...(await resolveHwDecodeArgs(ffmpeg, undefined)),
    '-i', inputPath,
    '-map', '0:v:0',
    ...(meta.hasAudio ? ['-map', '0:a:0?'] : ['-an']),
  ];
  const audioArgs = !meta.hasAudio
    ? []
    : streamPlan.transcodeAudio
      ? ['-c:a', 'aac', '-b:a', VIDEO_AUDIO_BITRATE]
      : ['-c:a', 'copy'];
  const outputArgs = ['-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', outputPath];

  if (!streamPlan.transcodeVideo) {
    await run(ffmpeg, [...commonArgs, '-c:v', 'copy', ...audioArgs, ...outputArgs], FFMPEG_TIMEOUT_MS);
    return;
  }

  const filters = [`scale=${targetW}:${targetH}:flags=lanczos`];
  if (convertToCfr) {
    const fps = String(Math.round(targetFps * 1000) / 1000);
    filters.push(`fps=fps=${fps}:start_time=0:round=near`);
  }
  const preferred = await resolveH264Encoder(ffmpeg);
  // Proxy transcodes use constant-quality when the hardware encoder supports
  // it: same perceptual quality, lower bitrate, less rate-control CPU.
  const proxyQuality = await probeEncoderQualityMode(ffmpeg, preferred);
  let lastError: unknown;
  for (const encoder of h264EncoderAttempts(preferred)) {
    const args = [
      ...commonArgs,
      '-vf', filters.join(','),
      ...h264EncodingArgs({
        encoder,
        targetBitrate,
        maxBitrate: targetBitrate,
        bufferSize: targetBitrate * 2,
        softwarePreset: 'veryfast',
        ...(proxyQuality ? { hardwareQuality: 23 } : {}),
      }),
      '-profile:v', 'high',
      ...(convertToCfr ? ['-fps_mode', 'cfr'] : []),
      ...audioArgs,
      ...outputArgs,
    ];
    try {
      await run(ffmpeg, args, FFMPEG_TIMEOUT_MS);
      return;
    } catch (error) {
      lastError = error;
      if (!isHardwareH264Encoder(encoder)) throw error;
      console.warn(`[normalize-media] ${encoder} failed; falling back to libx264`);
      await unlink(outputPath).catch(() => {});
    }
  }
  throw lastError instanceof Error ? lastError : new Error('media normalization failed');
}

export interface NormalizeEncodeContext {
  inputPath: string;
  outputPath: string;
  tempPath: string;
}

export interface NormalizeMediaPluginOptions {
  admission?: NormalizeAdmission;
  encoderHook?: (
    context: NormalizeEncodeContext,
    encode: () => Promise<void>,
  ) => Promise<void>;
}

export function normalizeMediaPlugin(options: NormalizeMediaPluginOptions = {}): Plugin {
  const admission = options.admission ?? normalizeAdmission;
  return {
    name: 'openchatcut-normalize-media',
    configureServer(server) {
      server.middlewares.use('/api/normalize-media', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        let tempOutput: string | null = null;
        let releasePermit: ReleaseNormalizePermit | null = null;
        try {
          const body = (await readJson(req)) as {
            src?: string;
            force?: boolean;
            optimize?: boolean;
            forceCfr?: boolean;
            targetFps?: number;
          };
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
          const outPath = resolveNormalizeOutputPath(inputPath);
          const outName = basename(outPath);
          const stem = basename(outName, extname(outName));
          releasePermit = await admission.acquire(await resolveNormalizeTargetKey(outPath));

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
            // A known video that cannot be inspected is unsafe to pass through:
            // Remotion may only surface the problem much later during preview/export.
            sendJson(res, 422, { error: `video compatibility check failed: ${message}`, code: 'MEDIA_PROBE_FAILED' });
            return;
          }

          const optimizeOutput = Boolean(body.force) || body.optimize === true;
          const { w: targetW, h: targetH } = targetDimension(meta.width, meta.height, optimizeOutput);
          const recommendedTargetBitrate = recommendedBitrate(targetW, targetH);
          const targetBitrate = optimizeOutput
            ? recommendedTargetBitrate
            : Math.max(recommendedTargetBitrate, meta.sourceBitrate);
          const forceCfr = Boolean(body.forceCfr);
          const allowRequestedFps = forceCfr || optimizeOutput;
          const targetFps = resolveTargetFps(
            body.targetFps,
            meta.avgFrameRate,
            meta.nominalFrameRate,
            allowRequestedFps,
          );
          const reason = body.force ? 'force' : normalizeReason(meta, targetBitrate, forceCfr, body.optimize === true);
          if (!reason) {
            sendJson(res, 200, {
              ok: true,
              path: src,
              normalized: false,
              reason: 'source accepted',
              bytes: meta.size,
              width: meta.width,
              height: meta.height,
              durationSeconds: playableDurationSeconds(meta) || undefined,
              videoFrameCount: meta.frameCount,
              fps: meta.avgFrameRate ?? meta.nominalFrameRate,
              variableFrameRate: meta.variableFrameRate,
            });
            return;
          }

          const tmpPath = createNormalizeTempPath(outPath);
          tempOutput = tmpPath;

          server.config.logger.info(`[normalize-media] ${name}: ${reason}`);
          const convertToCfr = forceCfr || meta.variableFrameRate;
          const streamPlan = resolveStreamPlan(meta, optimizeOutput, convertToCfr);
          const encode = () => encodeNormalized(
            inputPath,
            tmpPath,
            meta,
            targetW,
            targetH,
            targetBitrate,
            targetFps,
            convertToCfr,
            streamPlan,
          );
          if (options.encoderHook) {
            await options.encoderHook({ inputPath, outputPath: outPath, tempPath: tmpPath }, encode);
          } else {
            await encode();
          }

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
          const finalMeta = await probeVideo(finalPath);

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
            width: finalMeta.width,
            height: finalMeta.height,
            durationSeconds: playableDurationSeconds(finalMeta) || playableDurationSeconds(meta) || undefined,
            videoFrameCount: finalMeta.frameCount,
            fps: finalMeta.avgFrameRate ?? targetFps,
            variableFrameRate: finalMeta.variableFrameRate,
          });
        } catch (err) {
          if (err instanceof NormalizeAdmissionFullError) {
            sendJson(res, 429, { error: err.message, code: 'NORMALIZE_QUEUE_FULL' });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[normalize-media] ${message}`);
          const status = /ENOENT|spawn .*ffmpeg|spawn .*ffprobe/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        } finally {
          if (tempOutput) await unlink(tempOutput).catch(() => {});
          releasePermit?.();
        }
      });
    },
  };
}
