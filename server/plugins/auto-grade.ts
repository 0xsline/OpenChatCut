import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import {
  analyzeSignalFrames,
  createColorStreamProfile,
  type RawSignalFrame,
} from '../../src/color/autoGradeCore.ts';

const MAX_JSON = 16 * 1024;
const PROCESS_TIMEOUT_MS = 2 * 60_000;
const SAMPLE_COUNT = 10;

export function autoGradeSampleFps(durationSeconds: number): number {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : 0.001;
  return Math.max(0.001, Math.min(SAMPLE_COUNT / safeDuration, 10));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function runCapture(command: string, args: string[], timeoutMs = PROCESS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 12_000) stderr = stderr.slice(-6000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const match = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!match) return null;
  return isSafeUploadName(match[1]!) ? match[1]! : null;
}

interface ProbeStream {
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_range?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  duration?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function parseSignalStats(output: string): RawSignalFrame[] {
  const frames: RawSignalFrame[] = [];
  let current: RawSignalFrame | null = null;
  const flush = () => {
    if (current && Number.isFinite(current.yAverage)) frames.push(current);
    current = null;
  };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('frame:')) {
      flush();
      current = {};
      continue;
    }
    const match = line.match(/^lavfi\.signalstats\.(YMIN|YLOW|YAVG|YHIGH|YMAX|SATAVG)=(-?\d+(?:\.\d+)?)$/);
    if (!match) continue;
    current ??= {};
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === 'YMIN') current.yMin = value;
    else if (match[1] === 'YLOW') current.yLow = value;
    else if (match[1] === 'YAVG') current.yAverage = value;
    else if (match[1] === 'YHIGH') current.yHigh = value;
    else if (match[1] === 'YMAX') current.yMax = value;
    else current.saturationAverage = value;
  }
  flush();
  return frames;
}

export interface AnalyzeColorOptions {
  startSeconds?: number;
  durationSeconds?: number;
}

export async function analyzeColorInFile(file: string, options: AnalyzeColorOptions = {}) {
  const probeText = await runCapture(ffprobeBin(), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=pix_fmt,bits_per_raw_sample,color_range,color_transfer,color_primaries,color_space,duration:format=duration',
    '-of', 'json', file,
  ], 30_000);
  const probe = JSON.parse(probeText) as ProbeResult;
  const stream = probe.streams?.[0];
  if (!stream) throw new Error('media has no video stream');
  const profile = createColorStreamProfile(stream);
  const sourceDuration = finiteNonNegative(stream.duration ?? probe.format?.duration, 0);
  const startSeconds = Math.min(sourceDuration || Number.MAX_SAFE_INTEGER, finiteNonNegative(options.startSeconds, 0));
  const remaining = sourceDuration > 0 ? Math.max(0.001, sourceDuration - startSeconds) : 0;
  const requestedDuration = finiteNonNegative(options.durationSeconds, remaining || 1);
  const durationSeconds = remaining > 0 ? Math.min(remaining, Math.max(0.001, requestedDuration)) : Math.max(0.001, requestedDuration);
  const isStill = sourceDuration <= 0.05;
  // Spread the samples over the whole selected range. A 30-minute clip needs
  // a very low sampling FPS; clamping to normal playback rates would only
  // inspect the beginning of long media.
  const sampleFps = autoGradeSampleFps(durationSeconds);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  if (startSeconds > 0) args.push('-ss', startSeconds.toFixed(3));
  args.push('-i', file);
  if (!isStill) args.push('-t', durationSeconds.toFixed(3));
  args.push(
    '-vf', `${isStill ? '' : `fps=${sampleFps.toFixed(3)},`}signalstats,metadata=print:file=-`,
    '-frames:v', String(isStill ? 1 : SAMPLE_COUNT), '-an', '-f', 'null', '-',
  );
  const frames = parseSignalStats(await runCapture(ffmpegBin(), args));
  if (!frames.length) throw new Error('ffmpeg signalstats returned no samples');
  return {
    ...analyzeSignalFrames(frames, profile),
    analyzedStartSeconds: startSeconds,
    analyzedDurationSeconds: durationSeconds,
  };
}

export function autoGradePlugin(): Plugin {
  return {
    name: 'openchatcut-auto-grade',
    configureServer(server) {
      server.middlewares.use('/api/auto-grade', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          const body = (await readJson(req)) as AnalyzeColorOptions & { src?: string };
          const src = String(body.src ?? '').trim();
          const name = uploadNameFromSrc(src);
          const file = name ? resolveUploadFile(name) : null;
          if (!name || !file) {
            sendJson(res, 404, { error: 'auto grade requires a local /media/uploads source' });
            return;
          }
          const fileInfo = await stat(file);
          if (!fileInfo.isFile()) {
            sendJson(res, 404, { error: 'media file not found' });
            return;
          }
          const analysis = await analyzeColorInFile(file, body);
          sendJson(res, 200, { ok: true, src, ...analysis });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[auto-grade] ${message}`);
          const status = /ENOENT|spawn|ffmpeg|ffprobe/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
