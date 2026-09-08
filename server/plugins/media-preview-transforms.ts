import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { resolveHwDecodeArgs } from '../media-acceleration.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../media-process.ts';
import { runPreviewProcess } from '../preview-proxy.ts';

export const PEAKS_PER_SECOND = 100; // source samplesPerPeak = sampleRate/100
const MAX_PEAK_BINS = 12_000; // Reduce the density of ultra-long assets (far wider than any screen pixel width, no loss of appearance)
const PCM_RATE = 8000; // The peak envelope is sufficient and decoding is fast
const STRIP_HEIGHT = 44;
const MIN_STRIP_FRAMES = 8;
const MAX_STRIP_FRAMES = 32;
const SECONDS_PER_STRIP_FRAME = 8;
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
const MAX_STRIP_WIDTH = 2048;

function abortError(): Error {
  const error = new Error('derivative request cancelled');
  error.name = 'AbortError';
  return error;
}

function run(cmd: string, args: string[], signal: AbortSignal, timeoutMs = FFMPEG_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess(cmd, [...ffmpegThreadArgs(), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const abort = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(abortError());
      else if (timedOut) reject(new Error(`${cmd} timed out`));
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

interface Probe { durationMs: number; width: number; height: number; hasAudio: boolean }

export async function probe(file: string, signal: AbortSignal): Promise<Probe> {
  const { stdout } = await runPreviewProcess(ffprobeBin(), [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    file,
  ], signal, 30_000);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  return {
    durationMs: Math.max(0, Math.round(Number(parsed.format?.duration ?? 0) * 1000)),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: !!parsed.streams?.some((stream) => stream.codec_type === 'audio'),
  };
}

interface PeakState {
  peaks: number[];
  samplesPerBin: number;
  binMax: number;
  inBin: number;
  carry: Buffer | null;
}

function appendPcmPeaks(chunk: Buffer, state: PeakState): void {
  let buffer = state.carry ? Buffer.concat([state.carry, chunk]) : chunk;
  state.carry = null;
  const usable = buffer.length - (buffer.length % 2);
  if (usable < buffer.length) state.carry = buffer.subarray(usable);
  for (let index = 0; index < usable; index += 2) {
    state.binMax = Math.max(state.binMax, Math.abs(buffer.readInt16LE(index)) / 32768);
    state.inBin += 1;
    if (state.inBin < state.samplesPerBin) continue;
    state.peaks.push(Math.round(state.binMax * 1000) / 1000);
    state.binMax = 0;
    state.inBin = 0;
  }
}

export function computePeaks(file: string, durationMs: number, signal: AbortSignal): Promise<number[]> {
  const seconds = Math.max(0.001, durationMs / 1000);
  const bins = Math.max(1, Math.min(MAX_PEAK_BINS, Math.round(seconds * PEAKS_PER_SECOND)));
  const state: PeakState = {
    peaks: [], samplesPerBin: Math.max(1, Math.floor((PCM_RATE * seconds) / bins)),
    binMax: 0, inBin: 0, carry: null,
  };
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess(ffmpegBin(), [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      ...ffmpegThreadArgs(),
      '-i', file, '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const abort = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, FFMPEG_TIMEOUT_MS);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => appendPcmPeaks(chunk, state));
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(abortError());
      else if (timedOut) reject(new Error('ffmpeg peaks timed out'));
      else if (code !== 0) reject(new Error(`ffmpeg peaks exit ${code}: ${stderr.slice(-300)}`));
      else {
        if (state.inBin > 0) state.peaks.push(Math.round(state.binMax * 1000) / 1000);
        resolve(state.peaks);
      }
    });
  });
}

export async function buildFilmstrip(file: string, probeResult: Probe, out: string, signal: AbortSignal): Promise<void> {
  const seconds = Math.max(0.001, probeResult.durationMs / 1000);
  const aspect = probeResult.width > 0 && probeResult.height > 0 ? probeResult.width / probeResult.height : 16 / 9;
  const cellWidth = Math.max(24, Math.min(160, Math.round(STRIP_HEIGHT * aspect))) & ~1;
  const desiredFrames = Math.max(MIN_STRIP_FRAMES, Math.min(MAX_STRIP_FRAMES, Math.round(seconds / SECONDS_PER_STRIP_FRAME)));
  const frameCount = Math.min(desiredFrames, Math.floor(MAX_STRIP_WIDTH / cellWidth));
  const work = await mkdtemp(join(tmpdir(), 'cc-strip-'));
  try {
    const cells = Array.from({ length: frameCount }, (_, index) => ({
      time: ((index + 0.5) / frameCount) * seconds,
      path: join(work, `f-${String(index).padStart(3, '0')}.jpg`),
    }));
    for (const cell of cells) {
      await run(ffmpegBin(), [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        ...(await resolveHwDecodeArgs(ffmpegBin(), undefined)),
        '-ss', String(cell.time), '-i', file, '-frames:v', '1',
        '-vf', `scale=${cellWidth}:${STRIP_HEIGHT}:force_original_aspect_ratio=increase,crop=${cellWidth}:${STRIP_HEIGHT}`,
        '-q:v', '5', cell.path,
      ], signal);
    }
    const present = cells.filter((cell) => existsSync(cell.path));
    if (!present.length) throw new Error('no frames extracted');
    await run(ffmpegBin(), [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', join(work, 'f-%03d.jpg'), '-vf', `tile=${present.length}x1`,
      '-frames:v', '1', '-q:v', '6', out,
    ], signal);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function buildFrame(file: string, time: number, out: string, signal: AbortSignal): Promise<void> {
  await run(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...(await resolveHwDecodeArgs(ffmpegBin(), undefined)),
    '-ss', String(time), '-i', file, '-frames:v', '1', '-an',
    '-vf', 'scale=960:540:force_original_aspect_ratio=decrease',
    '-q:v', '3', out,
  ], signal, 30_000);
}
