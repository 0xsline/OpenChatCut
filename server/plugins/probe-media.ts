// Local ffprobe behind POST /api/probe-media, the transport for the probe_media tool.
//
// probe_media used to run ffprobe inside the e2b cloud sandbox, so on a machine without
// E2B_API_KEY the tool failed with "e2b sandbox is not configured" — while import,
// previews, scene detection and export QA were all already running the ffprobe binary
// that ships with the app. Probing needs no sandbox: a user upload or a bundled product
// asset is read in place, and a public URL is pulled through safePublicFetch into a temp
// file first (ffprobe must never open URLs itself — that would bypass the SSRF guard).
// The raw ffprobe JSON goes back to the browser, where probe_media reduces it.
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Plugin } from 'vite';
import { ffprobeBin } from '../media-binaries.ts';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { spawnMediaProcess } from '../media-process.ts';
import { resolveProductAsset } from '../product-assets.ts';
import { safePublicFetch } from '../safe-public-fetch.ts';
import { readJsonBody, sendJson } from './export-http.ts';

const UPLOAD_PREFIX = '/media/uploads/';
const PROBE_TIMEOUT_MS = 30_000;
/** Whole remote pull, connect to last byte; a probe is not worth waiting longer for. */
const REMOTE_TIMEOUT_MS = 90_000;
const MAX_REMOTE_BYTES = 200_000_000;

export type ProbeSource =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'remote'; readonly url: string }
  | { readonly error: string };

/** Map the tool's `source` onto something ffprobe may open; an error when it is not ours to read. */
export function resolveProbeSource(source: string): ProbeSource {
  const trimmed = source.trim();
  if (!trimmed) return { error: 'source is required' };
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'remote', url: trimmed };
  if (trimmed.startsWith(UPLOAD_PREFIX)) {
    const name = trimmed.slice(UPLOAD_PREFIX.length);
    if (!isSafeUploadName(name)) return { error: `illegal local path ${trimmed}` };
    const path = resolveUploadFile(name);
    return path ? { kind: 'local', path } : { error: `local media not found: ${name}` };
  }
  if (trimmed.startsWith('/')) {
    const path = resolveProductAsset(trimmed);
    return path ? { kind: 'local', path } : { error: `local path not found: ${trimmed}` };
  }
  return { error: `unsupported source ${trimmed}: expected a /media/… path or a public http(s) URL` };
}

function runFfprobe(path: string): Promise<string> {
  const deferred = Promise.withResolvers<string>();
  const child = spawnMediaProcess(ffprobeBin(), [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, PROBE_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
  child.on('error', (error) => {
    clearTimeout(timer);
    deferred.reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) deferred.reject(new Error(`ffprobe timed out after ${PROBE_TIMEOUT_MS}ms`));
    else if (code === 0) deferred.resolve(stdout);
    else deferred.reject(new Error(`ffprobe exited ${code ?? 'unknown'}: ${stderr.trim().slice(-400) || 'unreadable media'}`));
  });
  return deferred.promise;
}

/** Raw `ffprobe -show_streams -show_format` JSON for one local file. */
export async function probeMediaFile(path: string): Promise<Record<string, unknown>> {
  const stdout = await runFfprobe(path);
  const parsed: unknown = JSON.parse(stdout || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ffprobe produced no JSON');
  return parsed as Record<string, unknown>;
}

/** Stream a public URL to disk, bounded in bytes and in wall time, through the SSRF-safe fetch. */
async function downloadBounded(url: string, path: string): Promise<void> {
  const signal = AbortSignal.timeout(REMOTE_TIMEOUT_MS);
  const response = await safePublicFetch(url, { signal });
  if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`);
  if (!response.body) throw new Error(`fetch ${url} returned no body`);
  let total = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_REMOTE_BYTES) callback(new Error(`remote file too large (over ${MAX_REMOTE_BYTES} bytes)`));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as WebReadableStream), cap, createWriteStream(path), { signal });
}

/** Probe a resolved source; a remote file lives in a temp dir only for the duration of the probe. */
export async function probeResolvedSource(source: Exclude<ProbeSource, { error: string }>): Promise<Record<string, unknown>> {
  if (source.kind === 'local') return probeMediaFile(source.path);
  const dir = await mkdtemp(join(tmpdir(), 'openchatcut-probe-'));
  try {
    const path = join(dir, 'input.media');
    await downloadBounded(source.url, path);
    return await probeMediaFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function probeMediaPlugin(): Plugin {
  return {
    name: 'openchatcut-probe-media',
    configureServer(server) {
      server.middlewares.use('/api/probe-media', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJsonBody(req)) as { source?: unknown };
          const source = resolveProbeSource(String(body?.source ?? ''));
          if ('error' in source) {
            sendJson(res, 400, { error: source.error });
            return;
          }
          const probe = await probeResolvedSource(source);
          sendJson(res, 200, { ok: true, probe });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[probe-media] ${message}`);
          // A missing ffprobe binary is a broken install, not a bad request.
          const status = /ENOENT|spawn/i.test(message) ? 503 : 400;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
