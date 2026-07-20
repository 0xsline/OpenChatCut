import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
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
