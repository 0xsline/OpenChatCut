import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import {
  DEFAULT_MAX_SCENES,
  DEFAULT_MIN_SCENE_MS,
  normalizeSceneCandidates,
  normalizeSceneThreshold,
  parseSceneMetadata,
  type SceneChange,
} from '../../src/scene-detection/detect.ts';
import type {
  SceneDetectionJobSnapshot,
  SceneDetectionJobStatus,
  SceneDetectionResult,
  SceneEvidence,
} from '../../src/scene-detection/jobs.ts';

const MAX_JSON = 16 * 1024;
const DETECT_TIMEOUT_MS = 30 * 60_000;
const JOB_RETENTION_MS = 60 * 60_000;
const MAX_ANALYSIS_FPS = 12;
const MAX_ANALYSIS_FRAMES = 36_000;
const EVIDENCE_OFFSET_MS = 200;
const FRAME_CACHE_LIMIT = 200;

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

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const match = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!match) return null;
  return isSafeUploadName(match[1]) ? match[1] : null;
}

function abortError(): Error {
  const error = new Error('scene detection cancelled');
  error.name = 'AbortError';
  return error;
}

interface CaptureOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
}

function runCapture(command: string, args: string[], options: CaptureOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 500).unref();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      options.onStderr?.(text);
      stderr += text;
      if (stderr.length > 12_000) stderr = stderr.slice(-6000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (options.signal?.aborted) finish(abortError());
      else if (code === 0) finish();
      else finish(new Error(`${command} exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function runBuffer(command: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function probeDurationMs(file: string, signal?: AbortSignal): Promise<number> {
  const output = await runCapture(ffprobeBin(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { timeoutMs: 30_000, signal });
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe duration failed');
  return Math.round(seconds * 1000);
}

export function sceneAnalysisFps(durationMs: number): number {
  const durationSeconds = Math.max(0.001, durationMs / 1000);
  return Math.max(1, Math.min(MAX_ANALYSIS_FPS, MAX_ANALYSIS_FRAMES / durationSeconds));
}

/** Parse FFmpeg `-progress` timestamps. FFmpeg reports *_us/*_ms values in microseconds. */
export function parseProgressTimeMs(line: string): number | null {
  const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
  if (match) return Math.max(0, Number(match[1]) / 1000);
  const clock = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!clock) return null;
  return (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000;
}

export interface DetectScenesOptions {
  threshold?: number;
  minSceneMs?: number;
  maxScenes?: number;
  signal?: AbortSignal;
  onProgress?: (update: {
    phase: Extract<SceneDetectionJobStatus, 'probing' | 'detecting' | 'finalizing'>;
    progress: number;
    processedMs: number;
    durationMs: number;
  }) => void;
}

export interface DetectScenesResult {
  durationMs: number;
  threshold: number;
  minSceneMs: number;
  sampleFps: number;
  scenes: SceneChange[];
}

/** Decode once at an adaptive low frame rate and let FFmpeg calculate inter-frame scene scores. */
export async function detectScenesInFile(
  file: string,
  options: DetectScenesOptions = {},
): Promise<DetectScenesResult> {
  const threshold = normalizeSceneThreshold(options.threshold);
  const minSceneMs = Math.max(100, Math.min(60_000, Math.round(options.minSceneMs ?? DEFAULT_MIN_SCENE_MS)));
  const maxScenes = Math.max(1, Math.min(500, Math.round(options.maxScenes ?? DEFAULT_MAX_SCENES)));
  options.onProgress?.({ phase: 'probing', progress: 0.01, processedMs: 0, durationMs: 0 });
  const durationMs = await probeDurationMs(file, options.signal);
  const sampleFps = sceneAnalysisFps(durationMs);
  options.onProgress?.({ phase: 'detecting', progress: 0.05, processedMs: 0, durationMs });
  // Keep a second full-rate analysis branch alive so FFmpeg progress advances even
  // when the selected scene-change branch emits no frames.
  const filter = [
    `[0:v:0]fps=${sampleFps.toFixed(4)},scale=320:-2:flags=fast_bilinear,split=2[scan][clock]`,
    `[scan]select='gt(scene,${threshold})',metadata=print:file=-[hits]`,
    '[clock]null[analysis_clock]',
  ].join(';');
  let progressBuffer = '';
  let lastProcessedMs = 0;
  const output = await runCapture(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
    '-filter_complex', filter,
    '-map', '[hits]', '-an', '-f', 'null', '-',
    '-map', '[analysis_clock]', '-an',
    '-progress', 'pipe:2', '-stats_period', '0.2', '-nostats', '-f', 'null', '-',
  ], {
    timeoutMs: DETECT_TIMEOUT_MS,
    signal: options.signal,
    onStderr(chunk) {
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const processedMs = parseProgressTimeMs(line.trim());
        if (processedMs === null || processedMs < lastProcessedMs) continue;
        lastProcessedMs = processedMs;
        const ratio = Math.max(0, Math.min(1, processedMs / durationMs));
        options.onProgress?.({
          phase: 'detecting',
          progress: 0.05 + ratio * 0.9,
          processedMs,
          durationMs,
        });
      }
    },
  });
  options.onProgress?.({ phase: 'finalizing', progress: 0.98, processedMs: durationMs, durationMs });
  const scenes = normalizeSceneCandidates(parseSceneMetadata(output), {
    threshold, minSceneMs, durationMs, maxScenes,
  });
  return { durationMs, threshold, minSceneMs, sampleFps, scenes };
}

function frameUrl(src: string, timeMs: number): string {
  return `/api/detect-scenes/frame?src=${encodeURIComponent(src)}&timeMs=${Math.round(timeMs)}`;
}

export function addSceneEvidence(src: string, scenes: readonly SceneChange[], durationMs: number): SceneEvidence[] {
  return scenes.map((scene) => {
    const beforeTimeMs = Math.max(0, scene.timeMs - EVIDENCE_OFFSET_MS);
    const afterTimeMs = Math.min(Math.max(0, durationMs - 1), scene.timeMs + EVIDENCE_OFFSET_MS);
    return {
      ...scene,
      beforeTimeMs,
      afterTimeMs,
      beforeThumbnailUrl: frameUrl(src, beforeTimeMs),
      afterThumbnailUrl: frameUrl(src, afterTimeMs),
    };
  });
}

interface InternalJob extends SceneDetectionJobSnapshot {
  controller: AbortController;
  file: string;
  options: Pick<DetectScenesOptions, 'threshold' | 'minSceneMs' | 'maxScenes'>;
}

const jobs = new Map<string, InternalJob>();
const terminalStatuses = new Set<SceneDetectionJobStatus>(['completed', 'failed', 'cancelled']);

function publicJob(job: InternalJob): SceneDetectionJobSnapshot {
  return {
    id: job.id,
    src: job.src,
    status: job.status,
    progress: job.progress,
    processedMs: job.processedMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
  };
}

function cleanJobs(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (terminalStatuses.has(job.status) && job.updatedAt < cutoff) jobs.delete(id);
  }
}

async function runJob(job: InternalJob): Promise<void> {
  try {
    const detected = await detectScenesInFile(job.file, {
      ...job.options,
      signal: job.controller.signal,
      onProgress(update) {
        if (job.status === 'cancelled') return;
        job.status = update.phase;
        job.progress = update.progress;
        job.processedMs = update.processedMs;
        job.updatedAt = Date.now();
      },
    });
    if (job.controller.signal.aborted) throw abortError();
    const result: SceneDetectionResult = {
      ...detected,
      scenes: addSceneEvidence(job.src, detected.scenes, detected.durationMs),
    };
    job.result = result;
    job.status = 'completed';
    job.progress = 1;
    job.processedMs = detected.durationMs;
    job.updatedAt = Date.now();
  } catch (error) {
    if (job.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      job.status = 'cancelled';
      job.error = null;
    } else {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    }
    job.updatedAt = Date.now();
  }
}

function mediaFromSrc(src: string): { src: string; file: string } | { error: string; status: number } {
  const name = uploadNameFromSrc(src);
  if (!name) return { error: 'src must be /media/uploads/<safe-name>', status: 400 };
  const file = resolveUploadFile(name);
  if (!file || !existsSync(file)) return { error: `media not found: ${name}`, status: 404 };
  return { src, file };
}

const frameCache = new Map<string, Promise<Buffer>>();

async function evidenceFrame(file: string, fileSize: number, timeMs: number): Promise<Buffer> {
  const key = `${file}:${fileSize}:${Math.round(timeMs)}`;
  const cached = frameCache.get(key);
  if (cached) return cached;
  const pending = runBuffer(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, timeMs) / 1000), '-i', file,
    '-frames:v', '1', '-vf', 'scale=320:-2:flags=fast_bilinear',
    '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1',
  ], 30_000).then((buffer) => {
    if (!buffer.length) throw new Error('no frame extracted');
    return buffer;
  }).catch((error) => {
    frameCache.delete(key);
    throw error;
  });
  frameCache.set(key, pending);
  while (frameCache.size > FRAME_CACHE_LIMIT) {
    const oldest = frameCache.keys().next().value as string | undefined;
    if (!oldest) break;
    frameCache.delete(oldest);
  }
  return pending;
}

export function sceneDetectionPlugin(): Plugin {
  return {
    name: 'openchatcut-scene-detection',
    configureServer(server) {
      server.middlewares.use('/api/detect-scenes', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        cleanJobs();
        try {
          if (pathname === '/frame' && req.method === 'GET') {
            const media = mediaFromSrc(url.searchParams.get('src') ?? '');
            if ('error' in media) { sendJson(res, media.status, { error: media.error }); return; }
            const timeMs = Number(url.searchParams.get('timeMs'));
            if (!Number.isFinite(timeMs) || timeMs < 0) { sendJson(res, 400, { error: 'timeMs must be a non-negative number' }); return; }
            const fileSize = (await stat(media.file)).size;
            const frame = await evidenceFrame(media.file, fileSize, timeMs);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'private, max-age=3600');
            res.end(frame);
            return;
          }

          if (pathname === '/jobs' && req.method === 'POST') {
            const body = (await readJson(req)) as {
              src?: string; threshold?: number; minSceneMs?: number; maxScenes?: number;
            };
            const media = mediaFromSrc(String(body.src ?? ''));
            if ('error' in media) { sendJson(res, media.status, { error: media.error }); return; }
            const now = Date.now();
            const job: InternalJob = {
              id: `scene_${randomUUID()}`,
              src: media.src,
              file: media.file,
              status: 'queued',
              progress: 0,
              processedMs: 0,
              createdAt: now,
              updatedAt: now,
              result: null,
              error: null,
              controller: new AbortController(),
              options: { threshold: body.threshold, minSceneMs: body.minSceneMs, maxScenes: body.maxScenes },
            };
            jobs.set(job.id, job);
            void runJob(job);
            sendJson(res, 202, publicJob(job));
            return;
          }

          const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
          if (jobMatch && (req.method === 'GET' || req.method === 'DELETE')) {
            const id = decodeURIComponent(jobMatch[1]!);
            const job = jobs.get(id);
            if (!job) { sendJson(res, 404, { error: `scene detection job not found: ${id}` }); return; }
            if (req.method === 'DELETE' && !terminalStatuses.has(job.status)) {
              job.status = 'cancelled';
              job.updatedAt = Date.now();
              job.controller.abort();
            }
            sendJson(res, 200, publicJob(job));
            return;
          }

          if (pathname !== '/' || req.method !== 'POST') {
            sendJson(res, 405, { error: 'unsupported scene detection route' });
            return;
          }

          // Backward-compatible synchronous endpoint used by the Agent tool.
          const body = (await readJson(req)) as {
            src?: string; threshold?: number; minSceneMs?: number; maxScenes?: number;
          };
          const media = mediaFromSrc(String(body.src ?? ''));
          if ('error' in media) { sendJson(res, media.status, { error: media.error }); return; }
          const fileSize = (await stat(media.file)).size;
          const result = await detectScenesInFile(media.file, body);
          sendJson(res, 200, {
            ok: true,
            src: media.src,
            fileSize,
            ...result,
            scenes: addSceneEvidence(media.src, result.scenes, result.durationMs),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[scene-detection] ${message}`);
          const status = /ENOENT|spawn|ffmpeg|ffprobe/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
