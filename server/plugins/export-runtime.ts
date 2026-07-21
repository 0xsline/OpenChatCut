import { spawn } from 'node:child_process';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import {
  h264EncoderAttempts,
  h264EncodingArgs,
  isHardwareH264Encoder,
  resolveH264Encoder,
} from '../media-acceleration.ts';
import { TaskLimiter, type ReleaseTaskPermit } from '../task-limiter.ts';

const DEFAULT_MAX_ACTIVE_EXPORTS = 1;
const MAX_ACTIVE_EXPORTS = 4;
const FFMPEG_TIMEOUT_MS = 60 * 60_000;
export const EXPORT_JOB_RETENTION_MS = 60 * 60_000;
const EXPORT_JOB_FILE_PREFIX = 'openchatcut-export-job-';
const EXPORT_JOB_EXTENSIONS = new Set(['mp4', 'webm', 'mp3', 'wav']);

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
  if (!filename.startsWith(EXPORT_JOB_FILE_PREFIX)) return false;
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return EXPORT_JOB_EXTENSIONS.has(extension);
}

export function exportJobFilename(id: string, extension: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id) || !EXPORT_JOB_EXTENSIONS.has(extension)) {
    throw new Error('invalid export job filename');
  }
  return `${EXPORT_JOB_FILE_PREFIX}${id}.${extension}`;
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

export function acquireExportPermit(): Promise<ReleaseTaskPermit> {
  return exportLimiter.acquire();
}

export function withExportPermit<T>(task: () => Promise<T>): Promise<T> {
  return exportLimiter.run(task);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

/** Re-sample presentation FPS; temporal interpolation intentionally stays off. */
export async function retimeFps(
  input: string,
  output: string,
  targetFps: number,
  codec: 'h264' | 'vp8',
  targetBitrate: number,
): Promise<void> {
  await unlink(output).catch(() => {});
  const base = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', `fps=${targetFps}`];
  try {
    if (codec === 'vp8') {
      await runFfmpeg([...base, '-c:v', 'libvpx', '-b:v', '4M', '-c:a', 'copy', output]);
      return;
    }
    await retimeH264(base, output, targetBitrate);
  } catch (error) {
    await unlink(output).catch(() => {});
    throw error;
  }
}

async function retimeH264(base: string[], output: string, targetBitrate: number): Promise<void> {
  const preferred = await resolveH264Encoder(ffmpegBin());
  let lastError: unknown;
  for (const encoder of h264EncoderAttempts(preferred)) {
    try {
      const videoArgs = h264EncodingArgs({
        encoder,
        ...(isHardwareH264Encoder(encoder) ? { targetBitrate } : { softwareCrf: 18 }),
        softwarePreset: 'medium',
      });
      await runFfmpeg([...base, ...videoArgs, '-c:a', 'copy', output]);
      return;
    } catch (error) {
      lastError = error;
      if (!isHardwareH264Encoder(encoder)) throw error;
      console.warn(`[export] ${encoder} failed during FPS conversion; falling back to libx264`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ffmpeg fps retime failed');
}

export function exportOutputSize(state: unknown, scale: number): { width: number; height: number } {
  const timeline = state as { width?: unknown; height?: unknown };
  return {
    width: Math.max(2, Math.round((Number(timeline.width) || 1920) * scale)),
    height: Math.max(2, Math.round((Number(timeline.height) || 1080) * scale)),
  };
}
