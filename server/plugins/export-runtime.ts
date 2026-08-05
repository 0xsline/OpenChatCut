import { spawn } from 'node:child_process';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { isSafeUploadName } from '../media-dir.ts';
import {
  h264EncoderAttempts,
  h264EncoderFallbackReason,
  h264EncoderProfile,
  h264EncodingArgs,
  h264FilterChain,
  h264GlobalArgs,
  shouldFallbackH264Encoder,
  resolveH264Encoder,
  type H264Encoder,
  type H264EncoderOutcome,
} from '../media-acceleration.ts';
import {
  deleteGenerationJob,
  getGenerationJobSnapshot,
  type UpdateGenerationJob,
} from './generation-jobs.ts';
import { TaskLimiter, type ReleaseTaskPermit } from '../task-limiter.ts';

const DEFAULT_MAX_ACTIVE_EXPORTS = 1;
const MAX_ACTIVE_EXPORTS = 4;
const FFMPEG_TIMEOUT_MS = 60 * 60_000;
export const EXPORT_JOB_RETENTION_MS = 60 * 60_000;
const EXPORT_CANCEL_TIMEOUT_MS = 15_000;
const EXPORT_JOB_FILE_PREFIX = 'openchatcut-export-job-';
const EXPORT_JOB_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mp3', 'wav']);
const EXPORT_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_JOB_FILENAME = /^openchatcut-export-job-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:mp4|webm|mov|mp3|wav)$/i;

interface CleanupStaleExportOptions {
  now?: number;
  retentionMs?: number;
  onError?: (path: string, error: unknown) => void;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isTemporaryExportFilename(filename: string): boolean {
  return EXPORT_JOB_FILENAME.test(filename);
}

export function exportJobFilename(id: string, extension: string): string {
  if (!EXPORT_JOB_ID.test(id) || !EXPORT_JOB_EXTENSIONS.has(extension)) {
    throw new Error('invalid export job filename');
  }
  return `${EXPORT_JOB_FILE_PREFIX}${id}.${extension}`;
}

export function exportJobResultName(path: string, assetId: string): string | null {
  const prefix = '/media/uploads/';
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  const match = EXPORT_JOB_FILENAME.exec(name);
  if (!isSafeUploadName(name) || !match || match[1].toLowerCase() !== assetId.toLowerCase()) return null;
  return name;
}

export async function unlinkWithRetry(path: string, attempts = 3, delayMs = 100): Promise<void> {
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/** Remove only expired async-export artifacts; ordinary user media is never matched. */
export async function cleanupStaleExportFiles(
  directory: string,
  options: CleanupStaleExportOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const retentionMs = Math.max(0, options.retentionMs ?? EXPORT_JOB_RETENTION_MS);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isTemporaryExportFilename(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < retentionMs) continue;
      await unlinkWithRetry(path);
      removed += 1;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      options.onError?.(path, error);
    }
  }
  return removed;
}

export function resolveMaxActiveExports(value = process.env.OPENCHATCUT_MAX_ACTIVE_EXPORTS): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return DEFAULT_MAX_ACTIVE_EXPORTS;
  return Math.max(1, Math.min(MAX_ACTIVE_EXPORTS, Number(value.trim())));
}

const exportLimiter = new TaskLimiter(resolveMaxActiveExports());
const exportJobControllers = new Map<string, AbortController>();

function acquireExportPermitWithSignal(signal: AbortSignal): Promise<ReleaseTaskPermit> {
  signal.throwIfAborted();
  const pending = exportLimiter.acquire();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void pending.then((release) => release());
      reject(signal.reason ?? new DOMException('Export cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then((release) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(release);
    });
  });
}

export function acquireExportPermit(signal?: AbortSignal): Promise<ReleaseTaskPermit> {
  return signal ? acquireExportPermitWithSignal(signal) : exportLimiter.acquire();
}
export function trackExportJobController(jobId: string, controller: AbortController): void {
  exportJobControllers.set(jobId, controller);
}

export function forgetExportJobController(jobId: string): void {
  exportJobControllers.delete(jobId);
}

export async function cancelActiveExportJob(jobId: string): Promise<boolean> {
  const controller = exportJobControllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  const deadline = Date.now() + EXPORT_CANCEL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = getGenerationJobSnapshot(jobId);
    if (!snapshot) return true;
    if (snapshot.status === 'succeeded' || snapshot.status === 'failed') {
      return deleteGenerationJob(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}


export async function withExportPermit<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquireExportPermit(signal);
  try {
    signal?.throwIfAborted();
    return await task();
  } finally {
    release();
  }
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    let settled = false;
    let timeoutError: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      timeoutError = new Error('ffmpeg fps retime timed out');
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(timeoutError ?? (code === 0
      ? undefined
      : new Error(`ffmpeg fps retime failed (${code}): ${stderr.slice(-600)}`))));
  });
}

export function retimeVideoEncodingArgs(
  codec: 'h264' | 'vp8',
  encoder: H264Encoder,
  targetBitrate: number,
): string[] {
  if (codec === 'vp8') return ['-c:v', 'libvpx', '-b:v', String(targetBitrate)];
  return h264EncodingArgs({ encoder, targetBitrate, softwarePreset: 'medium' });
}

/** Re-sample presentation FPS; temporal interpolation intentionally stays off. */
export async function retimeFps(
  input: string,
  output: string,
  targetFps: number,
  codec: 'h264' | 'vp8',
  targetBitrate: number,
  signal?: AbortSignal,
): Promise<H264EncoderOutcome | undefined> {
  await unlink(output).catch(() => {});
  const base = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  try {
    if (codec === 'vp8') {
      await runFfmpeg([
        ...base,
        '-i', input,
        '-vf', `fps=${targetFps}`,
        ...retimeVideoEncodingArgs('vp8', 'libx264', targetBitrate),
        '-c:a', 'copy',
        output,
      ], signal);
      return undefined;
    }
    return await retimeH264(base, input, output, targetFps, targetBitrate, signal);
  } catch (error) {
    await unlink(output).catch(() => {});
    throw error;
  }
}

async function retimeH264(
  base: string[],
  input: string,
  output: string,
  targetFps: number,
  targetBitrate: number,
  signal?: AbortSignal,
): Promise<H264EncoderOutcome> {
  const preferred = await resolveH264Encoder(ffmpegBin());
  let fallbackReason: string | undefined;
  let lastError: unknown;
  for (const encoder of h264EncoderAttempts(preferred)) {
    try {
      const args = [
        ...base,
        ...h264GlobalArgs(encoder),
        '-i', input,
        '-vf', h264FilterChain(encoder, [`fps=${targetFps}`]),
        ...retimeVideoEncodingArgs('h264', encoder, targetBitrate),
        '-c:a', 'copy',
        output,
      ];
      await runFfmpeg(args, signal);
      return {
        encoder: h264EncoderProfile(encoder),
        ...(fallbackReason ? { encoderFallbackReason: fallbackReason } : {}),
      };
    } catch (error) {
      lastError = error;
      if (!shouldFallbackH264Encoder(encoder, error)) throw error;
      fallbackReason = h264EncoderFallbackReason(encoder, error);
      await unlink(output).catch(() => {});
      console.warn(`[export] ${encoder} failed during FPS conversion; falling back to libx264`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ffmpeg fps retime failed');
}

export function finalH264EncoderOutcome(
  rendered: H264EncoderOutcome | undefined,
  retimed: H264EncoderOutcome | undefined,
): H264EncoderOutcome | undefined {
  if (!retimed) return rendered;
  if (retimed.encoder.hardware || retimed.encoderFallbackReason || !rendered?.encoderFallbackReason) {
    return retimed;
  }
  return { ...retimed, encoderFallbackReason: rendered.encoderFallbackReason };
}

export function createRenderProgress(
  update: UpdateGenerationJob,
  totalFrames: number,
  span: number,
): (value: number) => void {
  return (value) => {
    const normalized = Math.min(1, Math.max(0, Number(value) || 0));
    update({
      phase: 'rendering',
      progress: 8 + normalized * span,
      processedFrames: Math.min(totalFrames, Math.floor(normalized * totalFrames)),
      totalFrames,
    });
  };
}

export function exportOutputSize(state: unknown, scale: number): { width: number; height: number } {
  const timeline = state as { width?: unknown; height?: unknown };
  return {
    width: Math.max(2, Math.round((Number(timeline.width) || 1920) * scale)),
    height: Math.max(2, Math.round((Number(timeline.height) || 1080) * scale)),
  };
}
