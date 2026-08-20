import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from './media-process.ts';

const PROBE_TIMEOUT_MS = 60_000;
const PROXY_TIMEOUT_MS = 30 * 60_000;
const GOP_SAMPLE_SECONDS = 12;
const LONG_GOP_SECONDS = 4;
const MAX_CAPTURE_CHARS = 128 * 1024;
const DIRECT_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);

export interface PreviewSourceProbe {
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  longGop: boolean;
  unstableCodec: boolean;
}

export interface PreviewProcessOutput { stdout: string; stderr: string }

function abortError(): Error {
  const error = new Error('derivative request cancelled');
  error.name = 'AbortError';
  return error;
}

function appendBounded(value: string, chunk: Buffer): string {
  const next = value + String(chunk);
  return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS / 2);
}

export function runPreviewProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PreviewProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess(command, [...ffmpegThreadArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const abort = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(abortError());
      else if (timedOut) reject(new Error(`${command} timed out`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function parseLongGop(frames: Array<{ best_effort_timestamp_time?: string }> | undefined, durationMs: number): boolean {
  if (durationMs <= LONG_GOP_SECONDS * 2000) return false;
  const sampleEnd = Math.min(GOP_SAMPLE_SECONDS, durationMs / 1000);
  const times = (frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= sampleEnd)
    .sort((a, b) => a - b);
  if (!times.length) return true;
  let previous = 0;
  let largestGap = times[0];
  for (const time of times) {
    largestGap = Math.max(largestGap, time - previous);
    previous = time;
  }
  return Math.max(largestGap, sampleEnd - previous) > LONG_GOP_SECONDS;
}

export async function probePreviewSource(file: string, signal: AbortSignal): Promise<PreviewSourceProbe> {
  const { stdout } = await runPreviewProcess(ffprobeBin(), [
    '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-read_intervals', `%+${GOP_SAMPLE_SECONDS}`, '-show_frames', '-show_streams', '-show_format',
    '-show_entries', 'format=duration:stream=codec_name,width,height:frame=best_effort_timestamp_time',
    '-of', 'json', file,
  ], signal, PROBE_TIMEOUT_MS);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
    frames?: Array<{ best_effort_timestamp_time?: string }>;
  };
  const stream = parsed.streams?.[0];
  const durationMs = Math.max(0, Math.round(Number(parsed.format?.duration ?? 0) * 1000));
  const codec = stream?.codec_name?.toLowerCase() ?? '';
  return {
    durationMs,
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    codec,
    longGop: parseLongGop(parsed.frames, durationMs),
    unstableCodec: !DIRECT_CODECS.has(codec),
  };
}

export function previewProxyReason(probe: PreviewSourceProbe, force: boolean): string | null {
  if (force) return 'direct-preview-failed';
  if (probe.width > 1920 || probe.height > 1080) return 'high-resolution';
  if (probe.longGop) return 'long-gop';
  if (probe.unstableCodec) return 'unstable-codec';
  return null;
}

export async function buildPreviewProxy(file: string, output: string, signal: AbortSignal): Promise<void> {
  await runPreviewProcess(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', output,
  ], signal, PROXY_TIMEOUT_MS);
}

interface PreviewHit {
  name: string;
  file: string;
  source: { size: number; mtimeMs: number };
}

interface PreviewProxyDependencies {
  resolve: (req: IncomingMessage, res: ServerResponse) => Promise<PreviewHit | null>;
  cachePath: (name: string, source: PreviewHit['source'], kind: string, ext: string) => string;
  atomicBuild: (path: string, build: (tmp: string) => Promise<void>) => Promise<void>;
  runDerivative: <T>(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    protectedPath?: string,
  ) => Promise<T>;
  serveCached: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  handleError: (res: ServerResponse, label: string, error: unknown) => void;
  logError: (message: string) => void;
}

type ProxyPayload = {
  source: Omit<PreviewSourceProbe, 'unstableCodec'> & { src: string };
  proxy:
    | { status: 'not-needed'; reason: string }
    | { status: 'ready'; reason: string; previewSrc: string }
    | { status: 'failed'; reason: string; error: string };
};

function sourcePayload(src: string, probe: PreviewSourceProbe): ProxyPayload['source'] {
  return {
    src,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    codec: probe.codec,
    longGop: probe.longGop,
  };
}

async function previousFailure(path: string): Promise<{ reason: string; error: string } | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as { reason: string; error: string };
  } catch {
    return null;
  }
}

async function createProxyPayload(
  hit: PreviewHit,
  src: string,
  force: boolean,
  proxyPath: string,
  statusPath: string,
  deps: PreviewProxyDependencies,
  signal: AbortSignal,
): Promise<ProxyPayload> {
  const probe = await probePreviewSource(hit.file, signal);
  const source = sourcePayload(src, probe);
  const reason = previewProxyReason(probe, force);
  if (!reason) return { source, proxy: { status: 'not-needed', reason: 'source-compatible' } };
  const previewSrc = `/api/preview-proxy-file?src=${encodeURIComponent(src)}`;
  if (existsSync(proxyPath)) return { source, proxy: { status: 'ready', reason, previewSrc } };
  const failed = await previousFailure(statusPath);
  if (failed) return { source, proxy: { status: 'failed', ...failed } };
  try {
    await deps.atomicBuild(proxyPath, (tmp) => buildPreviewProxy(hit.file, tmp, signal));
    await unlink(statusPath).catch(() => {});
    return { source, proxy: { status: 'ready', reason, previewSrc } };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await deps.atomicBuild(statusPath, (tmp) => writeFile(tmp, JSON.stringify({ reason, error: message })));
    deps.logError(`[preview-proxy] ${message}`);
    return { source, proxy: { status: 'failed', reason, error: message } };
  }
}

export async function handlePreviewProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreviewProxyDependencies,
): Promise<void> {
  try {
    const hit = await deps.resolve(req, res);
    if (!hit) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const src = url.searchParams.get('src') ?? '';
    const force = url.searchParams.get('force') === '1';
    const proxyPath = deps.cachePath(hit.name, hit.source, 'proxy', 'mp4');
    const statusPath = deps.cachePath(hit.name, hit.source, 'proxy-status', 'json');
    let payload = await deps.runDerivative(req, res, proxyPath, (signal) => (
      createProxyPayload(hit, src, force, proxyPath, statusPath, deps, signal)
    ));
    if (force && payload.proxy.status === 'not-needed') {
      payload = await deps.runDerivative(req, res, `${proxyPath}#force`, (signal) => (
        createProxyPayload(hit, src, true, proxyPath, statusPath, deps, signal)
      ), proxyPath);
    }
    if (!res.destroyed) deps.sendJson(res, 200, payload);
  } catch (error) {
    deps.handleError(res, 'preview-proxy', error);
  }
}

export async function handlePreviewProxyFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreviewProxyDependencies,
): Promise<void> {
  try {
    const hit = await deps.resolve(req, res);
    if (!hit) return;
    const proxyPath = deps.cachePath(hit.name, hit.source, 'proxy', 'mp4');
    if (!existsSync(proxyPath)) {
      deps.sendJson(res, 404, { error: 'preview proxy is not ready' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    await deps.serveCached(req, res, proxyPath);
  } catch (error) {
    deps.handleError(res, 'preview-proxy-file', error);
  }
}
