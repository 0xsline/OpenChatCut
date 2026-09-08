// GET /api/hf-proxy/<owner>/<repo>/resolve/<rev>/<path...>
// Serves only verified files from installed catalog model packs. Network
// downloads are initiated exclusively by authenticated model-pack mutations.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ASR_MODELS, asrModelFile, type AsrModelFile } from '../../shared/asr-models.ts';
import { modelCachePath } from '../../shared/model-cache-path.ts';
import { MODEL_PACKS, type ModelPackFile } from '../../shared/model-packs/catalog.ts';
import {
  fileMatchesIntegrity,
  openContainedVerifiedFile,
} from './hf-integrity.ts';
import {
  downloadFromSource, throwIfDownloadAborted, MAX_CACHE_FILE_BYTES,
  type CurlContext, type DownloadModelFileOptions, type ProxyTarget,
} from './hf-download-transport.ts';
export { mergeDownloadedParts, settlePartDownloadRound } from './hf-download-transport.ts';
export type { DownloadModelFileOptions, PartStreamFactory, ProxyTarget } from './hf-download-transport.ts';

const MODEL_ID = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;
const REV = /^[A-Za-z0-9_.-]+$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;


/**
 * Download sources in priority order. ModelScope is first: measured 22.9MB/s
 * direct (no proxy) vs ~90KB/s for huggingface.co via proxy on this machine;
 * its mirrored files byte-match HF (sha-verified against the pinned catalog).
 * The official source uses parallel ranges; mirrors fall back to single-stream.
 */
const SOURCES: ReadonlyArray<{ name: string; url: (target: ProxyTarget) => string }> = [
  {
    name: 'modelscope',
    url: (target) => `https://modelscope.cn/api/v1/models/${target.modelId}/repo?Revision=master&FilePath=${target.filePath}`,
  },
  {
    name: 'huggingface',
    url: (target) => `https://huggingface.co/${target.modelId}/resolve/${target.revision}/${target.filePath}`,
  },
  {
    name: 'hf-cdn',
    url: (target) => `https://hf-cdn.sufy.com/${target.modelId}/resolve/${target.revision}/${target.filePath}`,
  },
  {
    name: 'hf-mirror',
    url: (target) => `https://hf-mirror.com/${target.modelId}/resolve/${target.revision}/${target.filePath}`,
  },
];

/**
 * Session-scoped "source does not visibly host this model" cache. Populated only
 * after a deterministic not-found failure (HTTP 404 or a mirror's own missing-repo
 * payload) on a source for a given modelId. Once recorded, later files of the same
 * model skip that source entirely instead of burning the doomed source's retry
 * rounds again. Keyed by modelId so a mirror that later gains the model is not
 * masked globally — a fresh session re-probes it. Transient failures (timeouts,
 * 5xx) never land here.
 */
const absentSourcesByModel = new Map<string, Set<string>>();

function sourceMissingOnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  // curl `--fail` exits 22 on any HTTP error; a genuine mirror absence surfaces
  // as an HTTP 404 in the stderr tail. Transient failures give other exit codes.
  if (/curl exit 22\b[\s\S]{0,200}\b404\b/i.test(message)) return true;
  // ModelScope reports a missing repo as JSON `{"Code":10990101007,...}`.
  if (/"Code"\s*:\s*10990101007/i.test(message)) return true;
  return false;
}
/** Pure classifier exposed for verifies: does this failure mean the source lacks the model? */
export { sourceMissingOnError };

function isSourceAbsent(modelId: string, sourceName: string): boolean {
  return absentSourcesByModel.get(modelId)?.has(sourceName) ?? false;
}

function markSourceAbsent(modelId: string, sourceName: string): void {
  let absent = absentSourcesByModel.get(modelId);
  if (!absent) {
    absent = new Set();
    absentSourcesByModel.set(modelId, absent);
  }
  absent.add(sourceName);
}

/** Test hook: clear the session-scoped absent-source cache. */
export function __resetModelMissingState(): void {
  absentSourcesByModel.clear();
}

/** Test hook: frozen snapshot of which (modelId, source) are marked absent. */
export function __getAbsentSourcesForVerify(): ReadonlyMap<string, readonly string[]> {
  return new Map([...absentSourcesByModel].map(([modelId, set]) => [modelId, [...set]]));
}

/** Shared user-data cache; never exposed through public/ or bundled into dist. */
export function modelCacheDir(): string {
  return modelCachePath(homedir());
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function contentTypeOf(file: string): string {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function fixedModelFile(target: ProxyTarget): ModelPackFile | AsrModelFile | undefined {
  for (const pack of MODEL_PACKS) {
    if (pack.modelId !== target.modelId || pack.revision !== target.revision) continue;
    const file = pack.files.find((candidate) => candidate.path === target.filePath);
    if (file) return file;
  }
  return asrModelFile(target.modelId, target.revision, target.filePath);
}

/** Parse an encoded proxy path and accept only exact catalog file tuples. */
export function parseTarget(rawPath: string): ProxyTarget | null {
  const encodedPath = rawPath.split('?', 1)[0] ?? '';
  const encoded = encodedPath.startsWith('/') ? encodedPath.slice(1) : encodedPath;
  if (!encoded || encoded.includes('\\') || /%(?:2f|5c)/i.test(encoded)) return null;
  let clean: string;
  try {
    clean = decodeURIComponent(encoded);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  const parts = clean.split('/');
  if (parts.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (parts.length < 5 || parts[2] !== 'resolve') return null;
  const modelId = `${parts[0]}/${parts[1]}`;
  const revision = parts[3] ?? '';
  const fileParts = parts.slice(4);
  if (!MODEL_ID.test(modelId) || !REV.test(revision)) return null;
  if (fileParts.some((segment) => !SEGMENT.test(segment))) return null;
  const target = { modelId, revision, filePath: fileParts.join('/') };
  if (fixedModelFile(target)) return target;
  // transformers.js v4 probes config/tokenizer files with revision "main"
  // (its get_files path drops the pinned revision). Resolve "main" to the
  // catalog-pinned revision so the whitelist keeps serving the exact locked
  // file tuple (same sha-verified bytes, just a different URL segment).
  if (revision === 'main') {
    const entry = ASR_MODELS.find((model) => model.modelId === modelId);
    if (entry) {
      const pinned: ProxyTarget = { modelId, revision: entry.revision, filePath: target.filePath };
      if (fixedModelFile(pinned)) return pinned;
    }
  }
  return null;
}

interface DownloadExpectation { readonly bytes?: number; readonly sha256?: string }

function downloadExpectation(
  target: ProxyTarget,
  options: DownloadModelFileOptions,
): DownloadExpectation {
  const fixed = fixedModelFile(target);
  const bytes = fixed?.sizeBytes ?? options.expectedBytes;
  const sha256 = fixed?.sha256 ?? options.expectedSha256;
  if (bytes !== undefined
    && (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_CACHE_FILE_BYTES)) {
    throw new Error(`invalid expected model size: ${bytes}`);
  }
  if (sha256 !== undefined && (!bytes || !/^[a-f0-9]{64}$/.test(sha256))) {
    throw new Error('expected model SHA-256 requires a valid size and lowercase digest');
  }
  return { bytes, sha256 };
}

async function reusableDownload(path: string, expected: DownloadExpectation): Promise<boolean> {
  if (expected.sha256 && expected.bytes) {
    return fileMatchesIntegrity(path, { sizeBytes: expected.bytes, sha256: expected.sha256 });
  }
  const size = (await stat(path)).size;
  return expected.bytes !== undefined
    ? size === expected.bytes
    : size > 0 && size <= MAX_CACHE_FILE_BYTES;
}

/** Download one model file into the disk cache (multi-source, verified). */
export async function downloadModelFile(
  target: ProxyTarget,
  destinationPath?: string,
  options: DownloadModelFileOptions = {},
): Promise<string> {
  const finalPath = destinationPath ?? join(modelCacheDir(), target.modelId, ...target.filePath.split('/'));
  const expected = downloadExpectation(target, options);
  const expectedBytes = expected.bytes;
  const expectedSha256 = expected.sha256;
  if (existsSync(finalPath)) {
    if (await reusableDownload(finalPath, expected)) return finalPath;
    await unlink(finalPath).catch(() => undefined);
  }
  await mkdir(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.part`;
  const context: CurlContext = { ...options, expectedBytes, expectedSha256, progress: new Map() };
  let completed = false;
  try {
    let lastError: unknown;
    for (const source of SOURCES) {
      throwIfDownloadAborted(options.signal);
      if (isSourceAbsent(target.modelId, source.name)) continue;
      try {
        await unlink(tmpPath).catch(() => undefined);
        context.progress.clear();
        await downloadFromSource(source, target, tmpPath, context);
        // Verify inside the loop so a mirror drift (sha mismatch) falls
        // through to the next source instead of failing the whole download.
        const size = (await stat(tmpPath)).size;
        if (expectedBytes !== undefined ? size !== expectedBytes : size <= 0 || size > MAX_CACHE_FILE_BYTES) {
          throw new Error(`model download produced an invalid file (${size} bytes)`);
        }
        if (expectedSha256 && expectedBytes
          && !await fileMatchesIntegrity(tmpPath, { sizeBytes: expectedBytes, sha256: expectedSha256 })) {
          throw new Error('model download failed integrity verification');
        }
        lastError = undefined;
        break;
      } catch (error) {
        if (sourceMissingOnError(error)) markSourceAbsent(target.modelId, source.name);
        lastError = error;
        await unlink(tmpPath).catch(() => undefined);
      }
    }
    if (lastError) throw lastError;
    const size = (await stat(tmpPath)).size;
    await rename(tmpPath, finalPath);
    completed = true;
    options.onProgress?.(size);
    return finalPath;
  } finally {
    if (!completed) await unlink(tmpPath).catch(() => undefined);
  }
}

interface InstalledModelFile { readonly handle: FileHandle; readonly path: string; readonly size: number }

async function openInstalledCatalogFile(target: ProxyTarget): Promise<InstalledModelFile | null> {
  const expected = fixedModelFile(target);
  if (!expected) return null;
  const cacheRoot = modelCacheDir();
  const packRoot = join(cacheRoot, target.modelId);
  const candidate = join(packRoot, ...expected.path.split('/'));
  const verified = await openContainedVerifiedFile(cacheRoot, packRoot, candidate, expected);
  return verified ? { ...verified, path: candidate } : null;
}

interface ByteRange { readonly start: number; readonly end: number }

function requestedRange(value: string, size: number): ByteRange | null | false {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1]) {
    const suffix = end;
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end >= size) return false;
  return { start, end };
}

async function serveInstalledFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: InstalledModelFile,
): Promise<void> {
  res.setHeader('Content-Type', contentTypeOf(file.path));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range ? requestedRange(req.headers.range, file.size) : null;
  if (range === false) {
    res.setHeader('Content-Range', `bytes */${file.size}`);
    sendJson(res, 416, { error: 'range not satisfiable' });
    return;
  }
  res.statusCode = range ? 206 : 200;
  if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
  res.setHeader('Content-Length', String(range ? range.end - range.start + 1 : file.size));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = file.handle.createReadStream({
    autoClose: false,
    start: range?.start ?? 0,
    end: range?.end ?? file.size - 1,
  });
  await pipeline(stream, res);
}

export async function handleHfProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  resolveInstalled: (target: ProxyTarget) => Promise<InstalledModelFile | null> = openInstalledCatalogFile,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed — use GET or HEAD' });
    return;
  }
  const target = parseTarget(req.url ?? '');
  if (!target) {
    sendJson(res, 400, { error: 'invalid or unavailable catalog model path' });
    return;
  }
  const file = await resolveInstalled(target);
  if (!file) {
    sendJson(res, 404, { error: 'model pack file is not installed and verified' });
    return;
  }
  try {
    await serveInstalledFile(req, res, file);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

export function hfProxyPlugin(): Plugin {
  return {
    name: 'openchatcut-hf-proxy',
    configureServer(server) {
      server.middlewares.use('/api/hf-proxy', (req, res) => {
        void handleHfProxyRequest(req, res).catch((error) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'model file request failed' });
            return;
          }
          if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
        });
      });
    },
  };
}
