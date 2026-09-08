import { createReadStream } from 'node:fs';
import { open, stat, unlink, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { proxyCurlArgs } from '../outbound-proxy.ts';

export const MAX_CACHE_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB hard cap
const CURL_TIMEOUT_S = 1800;
const CURL_ROUNDS = 6; // each round also retries internally (--retry 8)
const PARALLEL_CHUNKS = 4; // per-connection throttling → parallel byte ranges
const PARALLEL_MIN_BYTES = 8 * 1024 * 1024;

export interface ProxyTarget { modelId: string; revision: string; filePath: string }

export interface DownloadModelFileOptions {
  signal?: AbortSignal; onProgress?: (bytes: number) => void;
  expectedBytes?: number; expectedSha256?: string;
}

export interface CurlContext extends DownloadModelFileOptions { progress: Map<string, number> }

function downloadAborted(signal?: AbortSignal): Error {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('Model download cancelled');
  error.name = 'AbortError';
  return error;
}

export function throwIfDownloadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw downloadAborted(signal);
}

async function reportFileProgress(context: CurlContext, path: string): Promise<void> {
  if (!context.onProgress) return;
  const bytes = await stat(path).then((value) => value.size).catch(() => 0);
  context.progress.set(path, bytes);
  context.onProgress([...context.progress.values()].reduce((sum, value) => sum + value, 0));
}

function curlArgs(
  url: string, out: string, range: string | undefined, maxBytes: number, noProxy: boolean,
): string[] {
  const transferLimit = Math.min(MAX_CACHE_FILE_BYTES, maxBytes + 64 * 1024);
  const args = [
    '-sSL', '--fail', '--max-time', String(CURL_TIMEOUT_S),
    '--max-filesize', String(transferLimit),
    '--speed-limit', '1024', '--speed-time', '30',
    // Deliberately WITHOUT `--retry-all-errors`: that flag makes curl retry
    // deterministic 4xx failures (e.g. a 404 "file not found" on a source that
    // does not mirror the repo), which just burns ~27s of retry delays per
    // round on a doomed source before the outer source loop can fall through.
    // `--retry 8` still handles transient errors (408/429/5xx, timeouts,
    // resets), and the outer CURL_ROUNDS loop retries the whole transfer.
    '--retry', '8', '--retry-delay', '3',
    // ModelScope is a domestic CDN: force direct connection (no proxy);
    // other sources keep the configured outbound proxy.
    ...(noProxy ? ['--noproxy', '*'] : proxyCurlArgs()),
  ];
  if (range) args.push('-r', range);
  else args.push('-C', '-');
  args.push('-o', out, url);
  return args;
}

function runCurl(
  url: string, out: string, range: string | undefined, maxBytes: number, context: CurlContext,
  noProxy = false,
): Promise<void> {
  throwIfDownloadAborted(context.signal);
  const args = curlArgs(url, out, range, maxBytes, noProxy);
  return new Promise<void>((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = context.onProgress
      ? setInterval(() => void reportFileProgress(context, out), 250)
      : undefined;
    const cleanup = () => {
      clearInterval(timer);
      context.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      void reportFileProgress(context, out);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => child.kill('SIGTERM');
    context.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (context.signal?.aborted) finish(downloadAborted(context.signal));
      else if (code === 0) finish();
      else finish(new Error(`model download failed (curl exit ${code}): ${stderr.slice(-300)}`));
    });
  });
}

async function downloadSingle(
  url: string, tmpPath: string, context: CurlContext, noProxy = false,
): Promise<void> {
  let lastError: unknown;
  for (let round = 0; round < CURL_ROUNDS; round += 1) {
    throwIfDownloadAborted(context.signal);
    try {
      await runCurl(url, tmpPath, undefined, context.expectedBytes ?? MAX_CACHE_FILE_BYTES, context, noProxy);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function probeRemoteSize(url: string, expectedBytes: number | undefined, signal?: AbortSignal): Promise<number> {
  throwIfDownloadAborted(signal);
  return new Promise<number>((resolve, reject) => {
    const child = spawn('curl', ['-sS', '--max-time', '60', '-L', '-r', '0-0', '-D', '-', '-o', '/dev/null', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const onAbort = () => child.kill('SIGTERM');
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code) => {
      cleanup();
      if (signal?.aborted) { reject(downloadAborted(signal)); return; }
      if (code !== 0) { reject(new Error(`range probe failed (curl exit ${code})`)); return; }
      const match = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(stdout);
      const size = match ? Number(match[1]) : NaN;
      if (!Number.isFinite(size) || size <= 0 || size > MAX_CACHE_FILE_BYTES) {
        reject(new Error(`invalid content-range: ${stdout.slice(0, 160)}`));
        return;
      }
      if (expectedBytes !== undefined && size !== expectedBytes) {
        reject(new Error(`remote model size mismatch: got ${size}, expected ${expectedBytes}`));
        return;
      }
      resolve(size);
    });
  });
}

export type PartStreamFactory = (path: string) => AsyncIterable<Buffer | Uint8Array | string>;

async function writeEntireChunk(file: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new Error('parallel download merge made no write progress');
    offset += bytesWritten;
  }
}

/** Merge range-download parts in order while retaining only one stream chunk. */
export async function mergeDownloadedParts(
  partPaths: readonly string[],
  destinationPath: string,
  expectedSize: number,
  streamFactory: PartStreamFactory = (path) => createReadStream(path),
): Promise<void> {
  const destination = await open(destinationPath, 'w');
  let total = 0;
  try {
    for (const partPath of partPaths) {
      for await (const value of streamFactory(partPath)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.length;
        if (total > expectedSize) break;
        await writeEntireChunk(destination, chunk);
      }
      if (total > expectedSize) break;
    }
  } finally {
    await destination.close();
  }
  if (total !== expectedSize) {
    throw new Error(`parallel download size mismatch: got ${total}, expected ${expectedSize}`);
  }
}

export async function settlePartDownloadRound(
  tasks: readonly (() => Promise<void>)[],
): Promise<unknown | null> {
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  const failure = results.find((result) => result.status === 'rejected');
  return failure?.reason ?? null;
}

async function downloadParallel(url: string, size: number, tmpPath: string, context: CurlContext): Promise<void> {
  const chunkSize = Math.ceil(size / PARALLEL_CHUNKS);
  const parts = Array.from({ length: PARALLEL_CHUNKS }, (_, index) => {
    const start = index * chunkSize;
    const end = index === PARALLEL_CHUNKS - 1 ? size - 1 : (index + 1) * chunkSize - 1;
    return { file: `${tmpPath}.${index}`, range: `${start}-${end}`, bytes: end - start + 1 };
  });
  await Promise.all(parts.map((part) => unlink(part.file).catch(() => undefined)));
  try {
    let lastError: unknown;
    for (let round = 0; round < CURL_ROUNDS; round += 1) {
      throwIfDownloadAborted(context.signal);
      lastError = await settlePartDownloadRound(parts.map((part) => (
        () => runCurl(url, part.file, part.range, part.bytes, context)
      )));
      if (!lastError) break;
    }
    if (lastError) throw lastError;
    await mergeDownloadedParts(parts.map((part) => part.file), tmpPath, size);
    context.onProgress?.(size);
  } finally {
    await Promise.all(parts.map((part) => unlink(part.file).catch(() => undefined)));
  }
}

export async function downloadFromSource(
  source: { name: string; url: (target: ProxyTarget) => string },
  target: ProxyTarget,
  tmpPath: string,
  context: CurlContext,
): Promise<void> {
  const url = source.url(target);
  if (source.name === 'modelscope') {
    // Domestic CDN, single-stream, direct connection.
    await downloadSingle(url, tmpPath, context, true);
    return;
  }
  if (source.name !== 'huggingface') {
    await downloadSingle(url, tmpPath, context);
    return;
  }
  const size = await probeRemoteSize(url, context.expectedBytes, context.signal);
  if (size < PARALLEL_MIN_BYTES) {
    await downloadSingle(url, tmpPath, context);
    return;
  }
  await downloadParallel(url, size, tmpPath, context);
}
