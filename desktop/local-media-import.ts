import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ffmpegBin, ffprobeBin } from '../server/media-binaries.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../server/media-process.ts';
import { resolveUploadFile, uploadDir } from '../server/media-dir.ts';
import { registerMediaReference } from '../server/media-references.ts';
import { normalizeSha256Hash } from '../shared/content-hash.ts';
import { sha256File } from '../shared/node-content-hash.ts';
import {
  normalizationAbortError,
  throwIfNormalizationAborted,
} from '../server/media-normalization.ts';

export interface LocalMediaImport {
  src: string;
  storedName: string;
  contentHash: string;
}

/** Sources above this size skip the full-file SHA-256: the second pass over
 * multi-GiB masters costs more than content-addressed dedup can save, and the
 * import pipeline (hash + normalize + ASR) already saturates disk I/O. */
const LARGE_HASH_SKIP_BYTES = 1.5 * 1024 * 1024 * 1024;

export interface LocalMediaImportDependencies {
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
  hashFile(path: string): Promise<string>;
  registerReference(directory: string, name: string, sourcePath: string): Promise<void>;
}

const DEFAULT_LOCAL_MEDIA_IMPORT_DEPENDENCIES: LocalMediaImportDependencies = {
  stat: (path) => stat(path),
  hashFile: sha256File,
  registerReference: registerMediaReference,
};

type ProbeStream = {
  codec_name?: unknown;
  profile?: unknown;
  pix_fmt?: unknown;
  tags?: { alpha_mode?: unknown };
};

function run(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  throwIfNormalizationAborted(signal);
  const deferred = Promise.withResolvers<string>();
  const child = spawnMediaProcess(command, [...ffmpegThreadArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let terminalError: Error | undefined;
  const onAbort = (): void => {
    terminalError = normalizationAbortError(signal);
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    terminalError = new Error(`${command} timed out after ${Math.round(timeoutMs / 1_000)}s`);
    child.kill('SIGKILL');
  }, timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => { stdout = `${stdout}${String(chunk)}`.slice(-1_000_000); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
  child.once('error', (error) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    deferred.reject(error);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (terminalError) deferred.reject(terminalError);
    else if (code === 0) deferred.resolve(stdout);
    else deferred.reject(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`));
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return deferred.promise;
}

/** Detect alpha from the probed pixel format rather than container or filename. */
export function hasAlphaPixelFormat(value: unknown): boolean {
  const format = String(value ?? '').trim().toLowerCase();
  return /^(?:yuva|gbrap|rgba|argb|bgra|abgr|ya)/.test(format);
}

export function isTransparentMovProbe(stream: ProbeStream | undefined): boolean {
  if (!stream) return false;
  if (hasAlphaPixelFormat(stream.pix_fmt)) return true;
  return String(stream.tags?.alpha_mode ?? '') === '1';
}

export function transparentMovProxyArgs(source: string, destination: string): string[] {
  return [
    '-y', '-i', source,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libvpx-vp9', ...ffmpegThreadArgs(), '-pix_fmt', 'yuva420p',
    '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0',
    '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
    '-c:a', 'libopus',
    destination,
  ];
}

export async function importLocalMedia(
  sourcePath: string,
  originalName: string,
  dependencies: LocalMediaImportDependencies = DEFAULT_LOCAL_MEDIA_IMPORT_DEPENDENCIES,
): Promise<LocalMediaImport> {
  const sourceInfo = await dependencies.stat(sourcePath);
  if (!sourceInfo.isFile()) throw new Error('local media source must be a file');
  const extension = extname(originalName).toLowerCase();
  const storedName = `${randomUUID()}${extension}`;
  const directory = uploadDir();
  const contentHash = sourceInfo.size > LARGE_HASH_SKIP_BYTES
    ? ''
    : normalizeSha256Hash(await dependencies.hashFile(sourcePath));
  if (contentHash !== '' && !contentHash) throw new Error('local media hash must be a SHA-256 hex digest');
  const finalInfo = await dependencies.stat(sourcePath);
  if (!finalInfo.isFile() || finalInfo.size !== sourceInfo.size || finalInfo.mtimeMs !== sourceInfo.mtimeMs) {
    throw new Error('local media source changed during import');
  }
  await dependencies.registerReference(directory, storedName, sourcePath);
  return { src: `/media/uploads/${storedName}`, storedName, contentHash };
}

/** Return null for ordinary MOV files and never replace or remove the original. */
export async function createTransparentMovProxy(
  storedName: string,
  signal?: AbortSignal,
): Promise<{ src: string } | null> {
  if (extname(storedName).toLowerCase() !== '.mov' || basename(storedName) !== storedName) return null;
  const source = resolveUploadFile(storedName);
  if (!source) return null;
  const probe = JSON.parse(await run(ffprobeBin(), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt:stream_tags=alpha_mode',
    '-of', 'json', source,
  ], 10_000, signal)) as { streams?: ProbeStream[] };
  if (!isTransparentMovProbe(probe.streams?.[0])) return null;

  const proxyName = `${basename(storedName, '.mov')}.alpha.webm`;
  const destination = join(uploadDir(), proxyName);
  await run(ffmpegBin(), transparentMovProxyArgs(source, destination), 60 * 60_000, signal);
  return { src: `/media/uploads/${proxyName}` };
}
