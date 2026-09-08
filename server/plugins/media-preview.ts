import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { isSafeUploadName, resolveUploadFile, serveDiskFile, uploadDir, uploadReadDirs } from '../media-dir.ts';
import { derivativeQueue, type DerivativeWork } from '../derivative-queue.ts';
import { handlePreviewProxy, handlePreviewProxyFile } from '../preview-proxy.ts';
import { capturePreviewGenerationEpoch, invalidatePreviewGenerations, isPreviewGenerationCurrent } from '../preview-cache-epoch.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { PEAKS_PER_SECOND, probe, computePeaks, buildFilmstrip, buildFrame } from './media-preview-transforms.ts';

const PREVIEW_TRANSFORM_VERSION = 'preview-v3';
const DEFAULT_PREVIEW_MAX_BYTES = 512 * 1024 * 1024;
const PREVIEW_GC_INTERVAL_MS = 5 * 60_000;
const activePreviewPaths = new Set<string>();
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
/** Derivative endpoints spawn ffmpeg/ffprobe per request; gate them on the
 * same loopback + local-Host shape as the media reads they derive from. */
function requireEditorRead(req: IncomingMessage, res: ServerResponse): boolean {
  if (editorCredentialAuthorized(req, false)) return true;
  req.resume();
  sendJson(res, 403, { error: 'local editor request required' });
  return false;
}
function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const m = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!m) return null;
  return isSafeUploadName(m[1]) ? m[1] : null;
}
function previewDir(root = uploadDir()): string {
  return join(root, '.preview');
}

export interface PreviewSourceFingerprint { size: number; mtimeMs: number }

export function previewFingerprint(source: PreviewSourceFingerprint): string {
  return `${PREVIEW_TRANSFORM_VERSION}-${Math.max(0, Math.floor(source.size))}-${Math.max(0, Math.floor(source.mtimeMs * 1000))}`;
}

export function previewCachePath(
  name: string,
  source: PreviewSourceFingerprint,
  kind: string,
  ext: string,
): string {
  const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return join(previewDir(), `${safeName}.${previewFingerprint(source)}.${kind}.${ext}`);
}

export interface PreviewCacheEntry { path: string; bytes: number; lastAccessedAt: number }

export function selectPreviewEvictions(
  entries: PreviewCacheEntry[],
  maxBytes: number,
  protectedPaths: ReadonlySet<string> = new Set(),
): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const removed: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)) {
    if (total <= maxBytes) break;
    if (protectedPaths.has(entry.path)) continue;
    removed.push(entry.path);
    total -= entry.bytes;
  }
  return removed;
}

function previewMaxBytes(): number {
  const value = Number(process.env.MEDIA_PREVIEW_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_PREVIEW_MAX_BYTES;
}

function isPreviewDerivative(name: string): boolean {
  return /\.(?:peaks\.json|strip\.jpg|frame-\d+\.jpg|poster\.jpg|proxy\.mp4|proxy-status\.json)$/.test(name);
}

async function previewEntries(): Promise<PreviewCacheEntry[]> {
  const entries: PreviewCacheEntry[] = [];
  for (const root of uploadReadDirs()) {
    const dir = previewDir(root);
    const names = await readdir(dir).catch(() => [] as string[]);
    const rows = await Promise.all(names.filter(isPreviewDerivative).map(async (name) => {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      return info?.isFile() ? { path, bytes: info.size, lastAccessedAt: info.mtimeMs } : null;
    }));
    entries.push(...rows.filter((entry): entry is PreviewCacheEntry => entry !== null));
  }
  return entries;
}

async function prunePreviewCache(protectedPaths: ReadonlySet<string> = new Set()): Promise<void> {
  const protectedAll = new Set([...protectedPaths, ...activePreviewPaths]);
  const victims = selectPreviewEvictions(await previewEntries(), previewMaxBytes(), protectedAll);
  await Promise.all(victims.map((path) => unlink(path).catch(() => {})));
}

async function atomicPreviewBuild(path: string, build: (tmp: string) => Promise<void>): Promise<void> {
  await mkdir(previewDir(), { recursive: true });
  const extension = extname(path);
  const tmp = `${path}.${randomUUID()}.tmp${extension}`;
  const generation = capturePreviewGenerationEpoch(path);
  try {
    await build(tmp);
    if (!isPreviewGenerationCurrent(generation)) throw new Error('preview source was deleted during generation');
    await rename(tmp, path);
    if (!isPreviewGenerationCurrent(generation)) throw new Error('preview source was deleted during rename');
  } catch (error) {
    await unlink(tmp).catch(() => {});
    if (!isPreviewGenerationCurrent(generation)) await unlink(path).catch(() => {});
    throw error;
  }
}

export async function deleteMediaPreviewDerivatives(name: string): Promise<number> {
  if (!isSafeUploadName(name)) return 0;
  invalidatePreviewGenerations(name);
  const cacheName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  let removed = 0;
  for (const root of uploadReadDirs()) {
    const dir = previewDir(root);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const candidate of names) {
      if (!candidate.startsWith(`${cacheName}.`) || !isPreviewDerivative(candidate)) continue;
      try {
        await unlink(join(dir, candidate));
        removed += 1;
      } catch { /* already removed */ }
    }
  }
  return removed;
}

async function readCachedPreview(path: string): Promise<Buffer> {
  const data = await readFile(path);
  const now = new Date();
  await utimes(path, now, now).catch(() => {});
  await prunePreviewCache();
  return data;
}


async function resolveReq(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const name = uploadNameFromSrc(url.searchParams.get('src') ?? '');
  if (!name) { sendJson(res, 400, { error: 'src must be /media/uploads/<name>' }); return null; }
  const file = resolveUploadFile(name);
  if (!file || !existsSync(file)) { sendJson(res, 404, { error: 'media not found' }); return null; }
  const source = await stat(file);
  return { name, file, source: { size: source.size, mtimeMs: source.mtimeMs } };
}

async function runDerivative<T>(
  _req: IncomingMessage,
  res: ServerResponse,
  key: string,
  work: DerivativeWork<T>,
  protectedPath = key,
): Promise<T> {
  const lease = derivativeQueue.acquire(key, async (signal) => {
    activePreviewPaths.add(protectedPath);
    try {
      return await work(signal);
    } finally {
      activePreviewPaths.delete(protectedPath);
      void prunePreviewCache();
    }
  });
  const release = () => lease.release();
  res.once('close', release);
  try {
    return await lease.promise;
  } finally {
    res.removeListener('close', release);
    lease.release();
  }
}

function handleDerivativeError(
  res: ServerResponse,
  logError: (message: string) => void,
  label: string,
  error: unknown,
): void {
  if (res.destroyed || res.writableEnded) return;
  const message = error instanceof Error ? error.message : String(error);
  logError(`[${label}] ${message}`);
  sendJson(res, /spawn|ENOENT/i.test(message) ? 503 : 500, { error: message });
}

async function serveCachedFile(req: IncomingMessage, res: ServerResponse, cache: string): Promise<void> {
  const now = new Date();
  await utimes(cache, now, now).catch(() => {});
  activePreviewPaths.add(cache);
  try {
    await prunePreviewCache();
    await serveDiskFile(req, res, cache);
  } finally {
    activePreviewPaths.delete(cache);
    void prunePreviewCache();
  }
}

async function handleWaveform(req: IncomingMessage, res: ServerResponse, logError: (message: string) => void) {
  try {
    const hit = await resolveReq(req, res);
    if (!hit) return;
    const cache = previewCachePath(hit.name, hit.source, 'peaks', 'json');
    if (!existsSync(cache)) {
      await runDerivative(req, res, cache, async (signal) => {
        if (existsSync(cache)) return;
        const probeResult = await probe(hit.file, signal);
        const body = !probeResult.hasAudio
          ? { peaks: [], peaksPerSecond: PEAKS_PER_SECOND, durationMs: probeResult.durationMs }
          : {
              peaks: await computePeaks(hit.file, probeResult.durationMs, signal),
              peaksPerSecond: PEAKS_PER_SECOND,
              durationMs: probeResult.durationMs,
            };
        await atomicPreviewBuild(cache, (tmp) => writeFile(tmp, JSON.stringify(body)));
      });
    }
    if (res.destroyed) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(await readCachedPreview(cache));
  } catch (error) {
    handleDerivativeError(res, logError, 'waveform', error);
  }
}

async function handleFilmstrip(req: IncomingMessage, res: ServerResponse, logError: (message: string) => void) {
  try {
    const hit = await resolveReq(req, res);
    if (!hit) return;
    const cache = previewCachePath(hit.name, hit.source, 'strip', 'jpg');
    if (!existsSync(cache)) {
      await runDerivative(req, res, cache, async (signal) => {
        if (existsSync(cache)) return;
        const probeResult = await probe(hit.file, signal);
        if (!probeResult.width || !probeResult.height) throw new Error('not a video');
        await atomicPreviewBuild(cache, (tmp) => buildFilmstrip(hit.file, probeResult, tmp, signal));
      });
    }
    if (res.destroyed) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(await readCachedPreview(cache));
  } catch (error) {
    handleDerivativeError(res, logError, 'filmstrip', error);
  }
}

async function handleMediaFrame(req: IncomingMessage, res: ServerResponse, logError: (message: string) => void) {
  try {
    const hit = await resolveReq(req, res);
    if (!hit) return;
    const rawTime = new URL(req.url ?? '/', 'http://localhost').searchParams.get('time');
    const requested = rawTime === null ? Number.NaN : Number(rawTime);
    if (!Number.isFinite(requested) || requested < 0) {
      sendJson(res, 400, { error: 'time must be a non-negative number' });
      return;
    }
    const cache = previewCachePath(hit.name, hit.source, `frame-${Math.round(requested * 1000)}`, 'jpg');
    if (!existsSync(cache)) {
      await runDerivative(req, res, cache, async (signal) => {
        if (existsSync(cache)) return;
        const probeResult = await probe(hit.file, signal);
        if (!probeResult.width || !probeResult.height) throw new Error('not a video');
        const time = Math.min(requested, Math.max(0, probeResult.durationMs / 1000 - 0.001));
        await atomicPreviewBuild(cache, (tmp) => buildFrame(hit.file, time, tmp, signal));
      });
    }
    if (res.destroyed) return;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    await serveCachedFile(req, res, cache);
  } catch (error) {
    handleDerivativeError(res, logError, 'media-frame', error);
  }
}

async function handleMediaPoster(req: IncomingMessage, res: ServerResponse, logError: (message: string) => void) {
  try {
    const hit = await resolveReq(req, res);
    if (!hit) return;
    const cache = previewCachePath(hit.name, hit.source, 'poster', 'jpg');
    if (!existsSync(cache)) {
      await runDerivative(req, res, cache, async (signal) => {
        if (existsSync(cache)) return;
        const probeResult = await probe(hit.file, signal);
        if (!probeResult.width || !probeResult.height) throw new Error('not a video');
        const time = Math.min(1, Math.max(0, probeResult.durationMs / 2000));
        await atomicPreviewBuild(cache, (tmp) => buildFrame(hit.file, time, tmp, signal));
      });
    }
    if (res.destroyed) return;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    await serveCachedFile(req, res, cache);
  } catch (error) {
    handleDerivativeError(res, logError, 'media-poster', error);
  }
}

export function mediaPreviewPlugin(): Plugin {
  return {
    name: 'openchatcut-media-preview',
    configureServer(server) {
      const logError = (message: string) => server.config.logger.error(message);
      const proxyDeps = {
        resolve: resolveReq, cachePath: previewCachePath, atomicBuild: atomicPreviewBuild,
        runDerivative, serveCached: serveCachedFile, sendJson, logError,
        handleError: (res: ServerResponse, label: string, error: unknown) => handleDerivativeError(res, logError, label, error),
      };
      void prunePreviewCache();
      const cleanupTimer = setInterval(() => { void prunePreviewCache(); }, PREVIEW_GC_INTERVAL_MS);
      cleanupTimer.unref?.();
      server.httpServer?.once('close', () => clearInterval(cleanupTimer));
      server.middlewares.use('/api/waveform', (req, res) => {
        if (requireEditorRead(req, res)) void handleWaveform(req, res, logError);
      });
      server.middlewares.use('/api/filmstrip', (req, res) => {
        if (requireEditorRead(req, res)) void handleFilmstrip(req, res, logError);
      });
      server.middlewares.use('/api/media-frame', (req, res) => {
        if (requireEditorRead(req, res)) void handleMediaFrame(req, res, logError);
      });
      server.middlewares.use('/api/media-poster', (req, res) => {
        if (requireEditorRead(req, res)) void handleMediaPoster(req, res, logError);
      });
      server.middlewares.use('/api/preview-proxy-file', (req, res) => {
        if (requireEditorRead(req, res)) void handlePreviewProxyFile(req, res, proxyDeps);
      });
      server.middlewares.use('/api/preview-proxy', (req, res) => {
        if (requireEditorRead(req, res)) void handlePreviewProxy(req, res, proxyDeps);
      });
    },
  };
}
