import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { ffmpegBin } from '../media-binaries.ts';
import { resolveHwDecodeArgs } from '../media-acceleration.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../media-process.ts';
import { isSafeUploadName, mimeFor, resolveUploadFile, uploadDir } from '../media-dir.ts';
import type { VideoRequest } from './video-validation.ts';
import { presignGetUpload, putUploadFile } from '../r2.ts';
import { fetchGeneratedResult } from './result-download.ts';

// MIME determination uses the media-dir table (the same table is used for upload access). There was originally a copy here that only recognized 6 species.
// A copy of the extension, and the rest will be image/jpeg — .heic/.heif/.avif/.gif/.mov These can indeed be entered
// The type of /media/uploads will be tagged with image/jpeg and sent to the supplier together with non-JPEG bytes.
export async function mediaDataUrl(path: string): Promise<string> {
  const { file } = localMedia(path);
  const bytes = await readFile(file);
  return `data:${mimeFor(file)};base64,${bytes.toString('base64')}`;
}

function localMedia(path: string): { file: string; name: string } {
  const clean = path.split(/[?#]/, 1)[0];
  if (!clean.startsWith('/media/uploads/')) throw new Error(`provider reference must be a project upload: ${path}`);
  const name = clean.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid project media path');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`project media not found: ${name}`);
  return { file, name };
}

export type ServerGenerationReferenceRole = 'first-frame' | 'last-frame' | 'reference-image' | 'reference-video' | 'reference-audio';

export interface ServerGenerationReference {
  kind: 'asset-master' | 'timeline-slice';
  role: ServerGenerationReferenceRole;
  assetId: string;
  path: string;
  sourceRevision?: string;
  itemId?: string;
  srcInFrame?: number;
  srcOutFrame?: number;
  playbackRate?: number;
  timelineDurationInFrames?: number;
  fps?: number;
}

export interface ReferencePreflightIssue {
  code: string;
  model?: string;
  role?: ServerGenerationReferenceRole;
  message: string;
}

export class ServerReferencePreflightError extends Error {
  readonly code = 'generation_reference_preflight';
  readonly issues: ReferencePreflightIssue[];

  constructor(issues: ReferencePreflightIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'ServerReferencePreflightError';
    this.issues = issues;
  }
}

const derivativeJobs = new Map<string, Promise<string>>();

function runSliceFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnMediaProcess(ffmpegBin(), [...ffmpegThreadArgs(), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000);
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`failed to materialize generation timeline slice: ${stderr.trim() || `ffmpeg exited ${code}`}`));
    });
  });
}

function atempoFilters(rate: number): string {
  const filters: number[] = [];
  let remaining = rate;
  while (remaining > 2) {
    filters.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push(0.5);
    remaining /= 0.5;
  }
  filters.push(remaining);
  return filters.map((value) => `atempo=${value.toFixed(6)}`).join(',');
}

async function timelineSlicePath(reference: ServerGenerationReference): Promise<string> {
  const source = localMedia(reference.path);
  const sourceStat = await stat(source.file);
  const fps = Number(reference.fps);
  const srcInFrame = Number(reference.srcInFrame);
  const srcOutFrame = Number(reference.srcOutFrame);
  const playbackRate = Number(reference.playbackRate);
  if (!Number.isFinite(fps) || fps <= 0
    || !Number.isFinite(srcInFrame) || srcInFrame < 0
    || !Number.isFinite(srcOutFrame) || srcOutFrame <= srcInFrame
    || !Number.isFinite(playbackRate) || playbackRate < 0.01) {
    throw new ServerReferencePreflightError([{
      code: 'invalid_timeline_slice',
      role: reference.role,
      message: `${reference.role} timeline slice has invalid frame/rate metadata`,
    }]);
  }
  const mediaKind = reference.role === 'reference-audio' ? 'audio' : 'video';
  const extension = mediaKind === 'audio' ? 'm4a' : 'mp4';
  const identity = JSON.stringify({
    assetId: reference.assetId,
    sourceRevision: reference.sourceRevision,
    sourceSize: sourceStat.size,
    sourceModifiedAt: sourceStat.mtimeMs,
    srcInFrame,
    srcOutFrame,
    playbackRate,
    timelineDurationInFrames: reference.timelineDurationInFrames,
    fps,
    mediaKind,
  });
  const filename = `generation-slice-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}.${extension}`;
  if (resolveUploadFile(filename)) return `/media/uploads/${filename}`;
  const pending = derivativeJobs.get(filename);
  if (pending) return pending;
  const derive = (async () => {
    const directory = uploadDir();
    await mkdir(directory, { recursive: true });
    const output = join(directory, filename);
    const sourceStartSeconds = srcInFrame / fps;
    const sourceDurationSeconds = (srcOutFrame - srcInFrame) / fps;
    const common = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(sourceStartSeconds),
      '-t', String(sourceDurationSeconds),
      ...(await resolveHwDecodeArgs(ffmpegBin(), undefined)),
      '-i', source.file,
    ];
    if (mediaKind === 'audio') {
      await runSliceFfmpeg([
        ...common,
        '-vn', '-af', atempoFilters(playbackRate),
        '-c:a', 'aac', '-b:a', '192k',
        output,
      ]);
    } else {
      await runSliceFfmpeg([
        ...common,
        '-an', '-vf', `setpts=PTS/${playbackRate}`,
        '-c:v', 'libx264', ...ffmpegThreadArgs(), '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        output,
      ]);
    }
    return `/media/uploads/${filename}`;
  })();
  derivativeJobs.set(filename, derive);
  try {
    return await derive;
  } finally {
    derivativeJobs.delete(filename);
  }
}

function parseServerReference(value: unknown): ServerGenerationReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServerReferencePreflightError([{ code: 'invalid_reference', message: 'generation reference must be an object' }]);
  }
  const reference = value as Partial<ServerGenerationReference>;
  const roles: ServerGenerationReferenceRole[] = ['first-frame', 'last-frame', 'reference-image', 'reference-video', 'reference-audio'];
  if ((reference.kind !== 'asset-master' && reference.kind !== 'timeline-slice')
    || !reference.role || !roles.includes(reference.role)
    || typeof reference.assetId !== 'string' || !reference.assetId
    || typeof reference.path !== 'string' || !reference.path) {
    throw new ServerReferencePreflightError([{ code: 'invalid_reference', message: 'generation reference kind, role, assetId, and path are required' }]);
  }
  return reference as ServerGenerationReference;
}

/** Validate reference roles and materialize timeline slices before provider validation/submission. */
export async function materializeVideoReferences(input: VideoRequest): Promise<VideoRequest> {
  if (input.generationReferences === undefined) return input;
  if (!Array.isArray(input.generationReferences)) {
    throw new ServerReferencePreflightError([{ code: 'invalid_references', model: input.model, message: 'generationReferences must be an array' }]);
  }
  const references = input.generationReferences.map(parseServerReference);
  const issues: ReferencePreflightIssue[] = [];
  const count = (role: ServerGenerationReferenceRole) => references.filter((reference) => reference.role === role).length;
  const firstFrames = count('first-frame');
  const lastFrames = count('last-frame');
  const images = count('reference-image');
  const videos = count('reference-video');
  const audios = count('reference-audio');
  if (lastFrames && !firstFrames) issues.push({ code: 'last_frame_requires_first', model: input.model, role: 'last-frame', message: `${input.model} lastFrame requires firstFrame` });
  if (input.model === 'hailuo' && (images || videos || audios)) issues.push({ code: 'hailuo_reference_role', model: input.model, message: 'hailuo does not support reference arrays' });
  if (input.model === 'seedance2') {
    if (lastFrames && (images || videos || audios)) issues.push({ code: 'seedance_last_frame_conflict', model: input.model, message: 'seedance2 lastFrame cannot be combined with reference arrays' });
    if (images > 9 || videos > 3 || audios > 3) issues.push({ code: 'seedance_reference_limit', model: input.model, message: 'seedance2 reference limit exceeded' });
    if (audios && !firstFrames && !images && !videos) issues.push({ code: 'seedance_audio_requires_visual', model: input.model, role: 'reference-audio', message: 'seedance2 audio references require a visual reference' });
  }
  if (input.model === 'kling') {
    if (audios) issues.push({ code: 'kling_audio_unsupported', model: input.model, role: 'reference-audio', message: 'kling does not support audio references' });
    if (videos > 1) issues.push({ code: 'kling_video_limit', model: input.model, role: 'reference-video', message: 'kling accepts at most one reference video' });
    const maxImages = videos ? 4 : 7;
    if (firstFrames + lastFrames + images > maxImages) issues.push({ code: 'kling_image_limit', model: input.model, role: 'reference-image', message: `kling accepts at most ${maxImages} image references for this request` });
  }
  if (issues.length) throw new ServerReferencePreflightError(issues);

  const paths = new Map<ServerGenerationReference, string>();
  await Promise.all(references.map(async (reference) => {
    if (reference.kind === 'timeline-slice' && reference.role !== 'reference-video' && reference.role !== 'reference-audio') {
      throw new ServerReferencePreflightError([{ code: 'role_slice_unsupported', model: input.model, role: reference.role, message: `${reference.role} cannot be a timeline slice` }]);
    }
    if (reference.kind === 'timeline-slice') paths.set(reference, await timelineSlicePath(reference));
    else {
      localMedia(reference.path);
      paths.set(reference, reference.path);
    }
  }));
  const rolePaths = (role: ServerGenerationReferenceRole) => references
    .filter((reference) => reference.role === role)
    .map((reference) => paths.get(reference)!);
  return {
    ...input,
    firstFramePath: rolePaths('first-frame')[0],
    lastFramePath: rolePaths('last-frame')[0],
    refImagePaths: rolePaths('reference-image'),
    refVideoPaths: rolePaths('reference-video'),
    refAudioPaths: rolePaths('reference-audio'),
  };
}

/** Providers that reject base64 video receive a temporary private-bucket URL. */
export async function providerMediaUrl(path: string): Promise<string> {
  const { file, name } = localMedia(path);
  await putUploadFile(name, file, mimeFor(file));
  const signed = await presignGetUpload(name, 3600);
  if (!signed) throw new Error('video references require configured R2 storage so the provider can fetch a temporary HTTPS URL');
  return signed.downloadUrl;
}

async function probeVideo(file: string): Promise<{ durationSeconds: number; width?: number; height?: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(output) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
        const durationSeconds = Number(parsed.format?.duration);
        if (code !== 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error();
        resolvePromise({ durationSeconds, width: parsed.streams?.[0]?.width, height: parsed.streams?.[0]?.height });
      } catch {
        reject(new Error('unable to probe generated video'));
      }
    });
  });
}

async function streamResponseToFile(response: Response, file: string, emptyMessage: string): Promise<void> {
  if (!response.body) throw new Error(emptyMessage);
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream),
    createWriteStream(file, { flags: 'wx' }),
  );
  if ((await stat(file)).size === 0) throw new Error(emptyMessage);
}

export async function saveVideo(url: string, fetchImpl?: NonNullable<Parameters<typeof fetchGeneratedResult>[2]>['fetchImpl']): Promise<{ path: string; durationSeconds: number; width?: number; height?: number }> {
  const response = await fetchGeneratedResult(url, 'video', { fetchImpl });
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.mp4`;
  const file = join(dir, filename);
  const partial = join(dir, `.${filename}.part`);
  try {
    await streamResponseToFile(response, partial, 'video provider returned empty video');
    const metadata = await probeVideo(partial);
    await rename(partial, file);
    return { path: `/media/uploads/${filename}`, ...metadata };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveImageUrl(url: string, fetchImpl?: NonNullable<Parameters<typeof fetchGeneratedResult>[2]>['fetchImpl']): Promise<string> {
  const response = await fetchGeneratedResult(url, 'image', { fetchImpl });
  const contentType = response.headers.get('content-type') ?? '';
  const urlExt = extname(new URL(url).pathname).slice(1).toLowerCase();
  const ext = contentType.includes('webp') || urlExt === 'webp' ? 'webp'
    : contentType.includes('jpeg') || urlExt === 'jpg' || urlExt === 'jpeg' ? 'jpg' : 'png';
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  const file = join(dir, filename);
  const partial = join(dir, `.${filename}.part`);
  try {
    await streamResponseToFile(response, partial, 'provider returned an empty last frame');
    await rename(partial, file);
    return `/media/uploads/${filename}`;
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}
