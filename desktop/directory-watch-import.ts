import { spawn } from 'node:child_process';
import { copyFile, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import type {
  DirectoryImportedFile,
  DirectoryImportMediaKind,
} from '../shared/directory-import.ts';
import { normalizeSha256Hash } from '../shared/content-hash.ts';
import { sha256File } from '../shared/node-content-hash.ts';
import { ffprobeBin } from '../server/media-binaries.ts';
import { uploadDir } from '../server/media-dir.ts';
import {
  normalizeMediaFile,
  type NormalizeMediaFileResult,
} from '../server/media-normalization-runner.ts';
import {
  normalizationAbortError,
  throwIfNormalizationAborted,
} from '../server/media-normalization.ts';
import {
  createTransparentMovProxy,
  importLocalMedia,
  type LocalMediaImport,
  type LocalMediaImportDependencies,
} from './local-media-import.ts';

const KIND_BY_EXTENSION: Record<string, DirectoryImportMediaKind> = {
  '.mp4': 'video', '.m4v': 'video', '.mov': 'video', '.webm': 'video',
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image',
  '.avif': 'image', '.heic': 'image', '.heif': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio',
  '.ogg': 'audio', '.opus': 'audio', '.flac': 'audio',
  '.gif': 'gif', '.svg': 'svg',
};

export interface DirectoryFileFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export interface PreparedDirectoryImport {
  readonly file: Omit<DirectoryImportedFile, 'importId'>;
  readonly fingerprint: DirectoryFileFingerprint;
  readonly createdPaths: readonly string[];
}

export type DirectoryCandidateResult =
  | { readonly status: 'unchanged'; readonly fingerprint: DirectoryFileFingerprint }
  | { readonly status: 'unsupported'; readonly fingerprint: DirectoryFileFingerprint }
  | { readonly status: 'duplicate'; readonly fingerprint: DirectoryFileFingerprint }
  | { readonly status: 'retry'; readonly retryImmediately: boolean }
  | { readonly status: 'imported'; readonly prepared: PreparedDirectoryImport };

export interface DirectoryImportDependencies {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<Stats>;
  readonly uploadDirectory: () => string;
  readonly canonicalUploadDirectory: () => Promise<string>;
  readonly importLocalMedia: typeof importLocalMedia;
  readonly createTransparentMovProxy: typeof createTransparentMovProxy;
  readonly normalizeVideo: (
    inputPath: string,
    publicSrc: string,
    signal: AbortSignal,
  ) => Promise<NormalizeMediaFileResult>;
  readonly probeMedia: (
    path: string,
    kind: DirectoryImportMediaKind,
    signal?: AbortSignal,
  ) => Promise<DirectoryMediaProbe>;
  readonly unlink: (path: string) => Promise<void>;
}

export interface DirectoryCandidateRequest {
  readonly sourcePath: string;
  readonly root: string;
  readonly name: string;
  readonly pinnedUploadDirectory: string;
  readonly knownFingerprint?: DirectoryFileFingerprint;
  readonly knownHashes: ReadonlySet<string>;
  readonly cancelled: () => boolean;
  readonly signal: AbortSignal;
}

export interface DirectoryMediaProbe {
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly sourceFps?: number;
}

export class DirectoryImportCancelledError extends Error {
  constructor() {
    super('directory import was cancelled');
    this.name = 'DirectoryImportCancelledError';
  }
}

export class DirectoryDestinationChangedError extends Error {
  constructor() {
    super('the media destination changed while the directory watch was active');
    this.name = 'DirectoryDestinationChangedError';
  }
}

interface DirectoryCopyDependencies {
  readonly copyFile: (source: string, destination: string, mode: number) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

export async function copyDirectoryMediaFile(
  source: string,
  destination: string,
  mode: number,
  dependencies: DirectoryCopyDependencies = { copyFile, unlink },
): Promise<void> {
  try {
    await dependencies.copyFile(source, destination, mode);
  } catch (error) {
    try {
      await dependencies.unlink(destination);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'directory media copy cleanup failed');
      }
    }
    throw error;
  }
}

const DIRECTORY_LOCAL_MEDIA_DEPENDENCIES: LocalMediaImportDependencies = {
  stat: (path) => stat(path),
  copyFile: copyDirectoryMediaFile,
  hashFile: sha256File,
};

function importDirectoryLocalMedia(sourcePath: string, name: string): Promise<LocalMediaImport> {
  return importLocalMedia(sourcePath, name, DIRECTORY_LOCAL_MEDIA_DEPENDENCIES);
}
function normalizeDirectoryVideo(
  inputPath: string,
  publicSrc: string,
  signal: AbortSignal,
): Promise<NormalizeMediaFileResult> {
  return normalizeMediaFile({
    inputPath,
    publicSrc,
    signal,
    publishR2: false,
    uploadsDirectory: dirname(inputPath),
  });
}



const DEFAULT_DEPENDENCIES: DirectoryImportDependencies = {
  realpath,
  stat,
  uploadDirectory: uploadDir,
  canonicalUploadDirectory: canonicalCurrentUploadDirectory,
  importLocalMedia: importDirectoryLocalMedia,
  createTransparentMovProxy,
  normalizeVideo: normalizeDirectoryVideo,
  probeMedia: probeDirectoryMedia,
  unlink,
};

function fingerprintOf(info: Stats): DirectoryFileFingerprint {
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
}

function sameFingerprint(left: DirectoryFileFingerprint, right: DirectoryFileFingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

export function isPathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && child !== '..' && !isAbsolute(child));
}

export async function canonicalCurrentUploadDirectory(): Promise<string> {
  const directory = resolve(uploadDir());
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}

async function checked<T>(promise: Promise<T>, cancelled: () => boolean): Promise<T> {
  const value = await promise;
  if (cancelled()) throw new DirectoryImportCancelledError();
  return value;
}

async function assertPinnedDestination(
  pinned: string,
  dependencies: DirectoryImportDependencies,
  cancelled: () => boolean,
): Promise<void> {
  const current = await checked(dependencies.canonicalUploadDirectory(), cancelled);
  if (current !== pinned) throw new DirectoryDestinationChangedError();
}

async function stableCandidate(
  request: DirectoryCandidateRequest,
  dependencies: DirectoryImportDependencies,
): Promise<{ path: string; fingerprint: DirectoryFileFingerprint } | null> {
  const firstPath = await checked(dependencies.realpath(request.sourcePath), request.cancelled);
  if (!isPathInside(request.root, firstPath)) return null;
  const firstInfo = await checked(dependencies.stat(firstPath), request.cancelled);
  if (!firstInfo.isFile()) return null;
  if (request.cancelled()) throw new DirectoryImportCancelledError();
  const finalPath = await checked(dependencies.realpath(request.sourcePath), request.cancelled);
  if (finalPath !== firstPath || !isPathInside(request.root, finalPath)) return null;
  const finalInfo = await checked(dependencies.stat(finalPath), request.cancelled);
  const firstFingerprint = fingerprintOf(firstInfo);
  const finalFingerprint = fingerprintOf(finalInfo);
  return sameFingerprint(firstFingerprint, finalFingerprint)
    ? { path: finalPath, fingerprint: finalFingerprint }
    : null;
}

function cleanupCandidates(
  pinnedDirectory: string,
  storedName: string,
  kind: DirectoryImportMediaKind,
  dependencies: DirectoryImportDependencies,
): string[] {
  const directories = new Set([pinnedDirectory, resolve(dependencies.uploadDirectory())]);
  const names = new Set([storedName]);
  if (kind === 'video') names.add(`${basename(storedName, extname(storedName))}.mp4`);
  if (extname(storedName).toLowerCase() === '.mov') {
    names.add(`${basename(storedName, '.mov')}.alpha.webm`);
  }
  return [...directories].flatMap((directory) => [...names].map((name) => join(directory, name)));
}

export async function removeDirectoryImportFiles(
  paths: readonly string[],
  dependencies: Pick<DirectoryImportDependencies, 'unlink'> = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const failures: unknown[] = [];
  for (const path of new Set(paths)) {
    try {
      await dependencies.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'failed to clean directory import files');
}

function parseRational(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const [rawNumerator, rawDenominator] = value.split('/');
  const numerator = Number(rawNumerator);
  const denominator = Number(rawDenominator ?? 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function runProbeProcess(args: readonly string[], signal?: AbortSignal): Promise<string> {
  throwIfNormalizationAborted(signal);
  const deferred = Promise.withResolvers<string>();
  const child = spawn(ffprobeBin(), [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let terminalError: Error | undefined;
  const onAbort = (): void => {
    terminalError = normalizationAbortError(signal);
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    terminalError = new Error('directory media probe timed out');
    child.kill('SIGKILL');
  }, 30_000);
  child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${String(chunk)}`.slice(-1_000_000); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
  child.once('error', (error) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    deferred.reject(error);
  });
  child.once('close', (code, closeSignal) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (terminalError) deferred.reject(terminalError);
    else if (code === 0) deferred.resolve(stdout);
    else deferred.reject(new Error(`ffprobe failed (${code ?? closeSignal ?? 'unknown'}): ${stderr.slice(-500)}`));
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return deferred.promise;
}

export async function probeDirectoryMedia(
  path: string,
  kind: DirectoryImportMediaKind,
  signal?: AbortSignal,
): Promise<DirectoryMediaProbe> {
  if (kind === 'svg') return {};
  const raw = await runProbeProcess([
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
  ], signal);
  const output = JSON.parse(raw) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streamType = kind === 'audio' ? 'audio' : 'video';
  const stream = output.streams?.find((candidate) => candidate.codec_type === streamType);
  if (!stream) throw new Error(`ffprobe found no ${streamType} stream`);
  const duration = Number(output.format?.duration ?? stream.duration);
  const width = Number(stream.width);
  const height = Number(stream.height);
  return {
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
    ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    ...(streamType === 'video'
      ? { sourceFps: parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate) }
      : {}),
  };
}

interface ResolvedDirectoryPublication {
  readonly src: string;
  readonly storedName: string;
  readonly probe: DirectoryMediaProbe;
  readonly compatibilityNormalized?: true;
  readonly proxyKind?: 'alpha-webm';
}

async function resolveDirectoryPublication(
  request: DirectoryCandidateRequest,
  dependencies: DirectoryImportDependencies,
  kind: DirectoryImportMediaKind,
  imported: LocalMediaImport,
): Promise<ResolvedDirectoryPublication> {
  const storedPath = join(request.pinnedUploadDirectory, imported.storedName);
  if (kind !== 'video') {
    const probe = await checked(
      dependencies.probeMedia(storedPath, kind, request.signal), request.cancelled,
    );
    return { src: imported.src, storedName: imported.storedName, probe };
  }
  const proxy = await checked(
    dependencies.createTransparentMovProxy(imported.storedName, request.signal), request.cancelled,
  );
  await assertPinnedDestination(request.pinnedUploadDirectory, dependencies, request.cancelled);
  if (proxy) {
    const proxyName = basename(proxy.src);
    const probe = await checked(
      dependencies.probeMedia(join(request.pinnedUploadDirectory, proxyName), kind, request.signal),
      request.cancelled,
    );
    return { src: proxy.src, storedName: imported.storedName, probe, proxyKind: 'alpha-webm' };
  }
  const normalized = await checked(
    dependencies.normalizeVideo(storedPath, imported.src, request.signal), request.cancelled,
  );
  await assertPinnedDestination(request.pinnedUploadDirectory, dependencies, request.cancelled);
  const finalPath = await checked(dependencies.realpath(normalized.outputPath), request.cancelled);
  if (!isPathInside(request.pinnedUploadDirectory, finalPath)) {
    throw new Error('normalized directory media escaped the pinned destination');
  }
  return {
    src: normalized.path,
    storedName: basename(finalPath),
    probe: {
      durationSeconds: normalized.durationSeconds,
      width: normalized.width,
      height: normalized.height,
      sourceFps: normalized.sourceFps,
    },
    compatibilityNormalized: true,
  };
}

async function completeCopiedCandidate(
  request: DirectoryCandidateRequest,
  dependencies: DirectoryImportDependencies,
  stable: { path: string; fingerprint: DirectoryFileFingerprint },
  kind: DirectoryImportMediaKind,
  imported: LocalMediaImport,
  createdPaths: readonly string[],
): Promise<DirectoryCandidateResult> {
  if (request.cancelled()) throw new DirectoryImportCancelledError();
  await assertPinnedDestination(request.pinnedUploadDirectory, dependencies, request.cancelled);
  const hash = normalizeSha256Hash(imported.contentHash);
  if (!hash) throw new Error('directory import returned an invalid content hash');
  if (request.knownHashes.has(hash)) {
    await removeDirectoryImportFiles(createdPaths, dependencies);
    return { status: 'duplicate', fingerprint: stable.fingerprint };
  }
  const publication = await resolveDirectoryPublication(request, dependencies, kind, imported);
  const finalPath = await checked(dependencies.realpath(request.sourcePath), request.cancelled);
  const finalInfo = await checked(dependencies.stat(finalPath), request.cancelled);
  if (finalPath !== stable.path || !sameFingerprint(fingerprintOf(finalInfo), stable.fingerprint)) {
    await removeDirectoryImportFiles(createdPaths, dependencies);
    return { status: 'retry', retryImmediately: true };
  }
  return {
    status: 'imported',
    prepared: {
      file: {
        name: request.name,
        src: publication.src,
        storedName: publication.storedName,
        contentHash: hash,
        kind,
        size: stable.fingerprint.size,
        ...publication.probe,
        sourceModifiedAt: Math.max(0, stable.fingerprint.mtimeMs),
        ...(publication.compatibilityNormalized ? { compatibilityNormalized: true as const } : {}),
        ...(publication.proxyKind ? { proxyKind: publication.proxyKind } : {}),
      },
      fingerprint: stable.fingerprint,
      createdPaths,
    },
  };
}

async function finishImportedCandidate(
  request: DirectoryCandidateRequest,
  dependencies: DirectoryImportDependencies,
  stable: { path: string; fingerprint: DirectoryFileFingerprint },
  kind: DirectoryImportMediaKind,
): Promise<DirectoryCandidateResult> {
  await assertPinnedDestination(request.pinnedUploadDirectory, dependencies, request.cancelled);
  const imported = await dependencies.importLocalMedia(stable.path, request.name);
  const createdPaths = cleanupCandidates(
    request.pinnedUploadDirectory, imported.storedName, kind, dependencies,
  );
  try {
    return await completeCopiedCandidate(
      request, dependencies, stable, kind, imported, createdPaths,
    );
  } catch (error) {
    const cleanupPaths = [
      ...createdPaths,
      ...cleanupCandidates(
        request.pinnedUploadDirectory, imported.storedName, kind, dependencies,
      ),
    ];
    await removeDirectoryImportFiles(cleanupPaths, dependencies).catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], 'directory import and cleanup failed');
    });
    throw error;
  }
}

export async function importDirectoryCandidate(
  request: DirectoryCandidateRequest,
  dependencies: DirectoryImportDependencies = DEFAULT_DEPENDENCIES,
): Promise<DirectoryCandidateResult> {
  let stable: { path: string; fingerprint: DirectoryFileFingerprint } | null;
  try {
    stable = await stableCandidate(request, dependencies);
  } catch (error) {
    if (error instanceof DirectoryImportCancelledError || request.cancelled() || request.signal.aborted) {
      throw new DirectoryImportCancelledError();
    }
    return { status: 'retry', retryImmediately: false };
  }
  if (!stable) return { status: 'retry', retryImmediately: false };
  if (request.knownFingerprint && sameFingerprint(request.knownFingerprint, stable.fingerprint)) {
    return { status: 'unchanged', fingerprint: stable.fingerprint };
  }
  const kind = KIND_BY_EXTENSION[extname(request.name).toLowerCase()];
  if (!kind) return { status: 'unsupported', fingerprint: stable.fingerprint };
  try {
    return await finishImportedCandidate(request, dependencies, stable, kind);
  } catch (error) {
    if (request.cancelled() || request.signal.aborted) throw new DirectoryImportCancelledError();
    if (error instanceof DirectoryImportCancelledError || error instanceof DirectoryDestinationChangedError) {
      throw error;
    }
    return { status: 'retry', retryImmediately: false };
  }
}
