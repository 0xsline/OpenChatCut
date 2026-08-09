import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  h264EncoderAttempts,
  h264EncodingArgs,
  isHardwareH264Encoder,
  probeEncoderQualityMode,
  resolveH264Encoder,
  resolveHwDecodeArgs,
} from './media-acceleration.ts';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import {
  createNormalizeAdmission,
  normalizationAbortError,
  throwIfNormalizationAborted,
} from './media-normalization-admission.ts';
export {
  createNormalizeAdmission,
  normalizationAbortError,
  NormalizeAdmissionFullError,
  throwIfNormalizationAborted,
} from './media-normalization-admission.ts';
export type {
  NormalizeAdmission,
  ReleaseNormalizePermit,
} from './media-normalization-admission.ts';

// Normalization implementation is shared by HTTP uploads and native directory imports.
const MAX_DIMENSION = 1920;
const SKIP_MAX_SOURCE_BITRATE_BPS = 8_000_000;
const TARGET_PEAK_BITRATE_BPS = 8_000_000;
const TARGET_FLOOR_BITRATE_BPS = 1_500_000;
const REFERENCE_PIXELS = 1920 * 1080;
const VIDEO_AUDIO_BITRATE = '160k';
const FFMPEG_TIMEOUT_MS = 60 * 60_000; // long masters


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

export const normalizeAdmission = createNormalizeAdmission();

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  throwIfNormalizationAborted(signal);
  const deferred = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let terminalError: Error | undefined;
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (error) deferred.reject(error);
    else deferred.resolve({ stdout, stderr });
  };
  const onAbort = (): void => {
    terminalError = normalizationAbortError(signal);
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    terminalError = new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`);
    child.kill('SIGKILL');
  }, timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${String(chunk)}`.slice(-1_000_000);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000);
  });
  child.once('error', (error) => finish(error));
  child.once('close', (code) => finish(terminalError ?? (code === 0
    ? undefined
    : new Error(`${cmd} exit ${code}: ${stderr.slice(-600)}`))));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return deferred.promise;
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

export async function probeVideo(path: string, signal?: AbortSignal): Promise<ProbeMeta> {
  const { stdout } = await run(
    ffprobeBin(),
    [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate,size:stream=index,codec_type,codec_name,width,height,bit_rate,avg_frame_rate,r_frame_rate,nb_frames',
      '-of', 'json',
      path,
    ],
    30_000,
    signal,
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
  throwIfNormalizationAborted(signal);
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

export function targetDimension(width: number, height: number, optimize: boolean): { w: number; h: number } {
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

export function recommendedBitrate(width: number, height: number): number {
  const scaled = TARGET_PEAK_BITRATE_BPS * ((width * height) / REFERENCE_PIXELS);
  const clamped = Math.min(TARGET_PEAK_BITRATE_BPS, Math.max(TARGET_FLOOR_BITRATE_BPS, scaled));
  return Math.ceil(clamped / 1000) * 1000;
}

export function normalizeReason(
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

interface TranscodeVideoOptions {
  readonly targetW: number;
  readonly targetH: number;
  readonly targetBitrate: number;
  readonly targetFps: number;
  readonly convertToCfr: boolean;
}

async function encodeTranscodedVideo(
  ffmpeg: string,
  commonArgs: string[],
  audioArgs: string[],
  outputArgs: string[],
  options: TranscodeVideoOptions,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const filters = [`scale=${options.targetW}:${options.targetH}:flags=lanczos`];
  if (options.convertToCfr) {
    const fps = String(Math.round(options.targetFps * 1000) / 1000);
    filters.push(`fps=fps=${fps}:start_time=0:round=near`);
  }
  const preferred = await resolveH264Encoder(ffmpeg);
  throwIfNormalizationAborted(signal);
  const proxyQuality = await probeEncoderQualityMode(ffmpeg, preferred);
  throwIfNormalizationAborted(signal);
  let lastError: unknown;
  for (const encoder of h264EncoderAttempts(preferred)) {
    const args = [
      ...commonArgs, '-vf', filters.join(','),
      ...h264EncodingArgs({
        encoder,
        targetBitrate: options.targetBitrate,
        maxBitrate: options.targetBitrate,
        bufferSize: options.targetBitrate * 2,
        softwarePreset: 'veryfast',
        ...(proxyQuality ? { hardwareQuality: 23 } : {}),
      }),
      '-profile:v', 'high',
      ...(options.convertToCfr ? ['-fps_mode', 'cfr'] : []),
      ...audioArgs, ...outputArgs,
    ];
    try {
      await run(ffmpeg, args, FFMPEG_TIMEOUT_MS, signal);
      return;
    } catch (error) {
      throwIfNormalizationAborted(signal);
      lastError = error;
      if (!isHardwareH264Encoder(encoder)) throw error;
      console.warn(`[normalize-media] ${encoder} failed; falling back to libx264`);
      await unlink(outputPath).catch(() => {});
    }
  }
  throw lastError instanceof Error ? lastError : new Error('media normalization failed');
}

export async function encodeNormalized(
  inputPath: string,
  outputPath: string,
  meta: ProbeMeta,
  targetW: number,
  targetH: number,
  targetBitrate: number,
  targetFps: number,
  convertToCfr: boolean,
  streamPlan: NormalizeStreamPlan,
  signal?: AbortSignal,
): Promise<void> {
  const ffmpeg = ffmpegBin();
  const commonArgs = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...(await resolveHwDecodeArgs(ffmpeg, undefined)),
    '-i', inputPath, '-map', '0:v:0',
    ...(meta.hasAudio ? ['-map', '0:a:0?'] : ['-an']),
  ];
  throwIfNormalizationAborted(signal);
  const audioArgs = !meta.hasAudio ? [] : streamPlan.transcodeAudio
    ? ['-c:a', 'aac', '-b:a', VIDEO_AUDIO_BITRATE]
    : ['-c:a', 'copy'];
  const outputArgs = ['-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', outputPath];
  if (!streamPlan.transcodeVideo) {
    await run(ffmpeg, [...commonArgs, '-c:v', 'copy', ...audioArgs, ...outputArgs], FFMPEG_TIMEOUT_MS, signal);
    return;
  }
  await encodeTranscodedVideo(
    ffmpeg,
    commonArgs,
    audioArgs,
    outputArgs,
    { targetW, targetH, targetBitrate, targetFps, convertToCfr },
    outputPath,
    signal,
  );
}

export interface NormalizeEncodeContext {
  inputPath: string;
  outputPath: string;
  tempPath: string;
}
