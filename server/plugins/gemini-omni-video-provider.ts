// Gemini Omni Flash (default `gemini-omni-1.2-flash`) via the Interactions API.
// Same auth/header style as Nano Banana image generation (GEMINI_API_KEY).
// Results use URI delivery: a Files API file that is polled until ACTIVE and
// downloaded with the key (https://ai.google.dev/gemini-api/docs/omni).
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { proxyDispatcher } from '../outbound-proxy.ts';
import { resolveUploadFile, isSafeUploadName, uploadDir } from '../media-dir.ts';
import { ffprobeBin } from '../media-binaries.ts';
import type { RegisterGenerationProviderTask } from './generation-jobs.ts';
import type { ValidVideoRequest } from './video-validation.ts';
import {
  buildOmniVideoRequestBodySync,
  extractOmniVideo,
  omniFileId,
  type OmniInputPart,
  type OmniVideoRequestBody,
} from './gemini-omni-video-helpers.ts';

export {
  extractOmniVideo,
  omniAspectRatio,
  omniDuration,
  omniFileId,
  omniResolution,
  omniTask,
} from './gemini-omni-video-helpers.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const DEFAULT_OMNI_MODEL = 'gemini-omni-1.2-flash';
const FILE_POLL_MS = 5_000;
const FILE_WAIT_MS = 10 * 60_000;
const FILE_TASK_PREFIX = 'file:';

export interface GeminiOmniVideoOptions {
  geminiBaseUrl: string;
  geminiApiKey: string;
  geminiOmniVideoModel: string;
}

function localUploadFile(path: string): string {
  if (!path.startsWith('/media/uploads/')) throw new Error(`gemini-omni reference must be a project upload: ${path}`);
  const name = path.slice('/media/uploads/'.length).split(/[?#]/, 1)[0]!;
  if (!isSafeUploadName(name)) throw new Error('invalid project media path');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`project media not found: ${path}`);
  return file;
}

function imageMime(file: string): string {
  const ext = extname(file).slice(1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext || 'png'}`;
}

async function imagePart(path: string): Promise<OmniInputPart> {
  const file = localUploadFile(path);
  return { type: 'image', data: (await readFile(file)).toString('base64'), mime_type: imageMime(file) };
}

export async function buildOmniVideoRequestBody(
  input: ValidVideoRequest,
  model: string,
): Promise<OmniVideoRequestBody> {
  const imageParts: OmniInputPart[] = [];
  if (input.firstFramePath) imageParts.push(await imagePart(input.firstFramePath));
  if (input.lastFramePath) imageParts.push(await imagePart(input.lastFramePath));
  for (const path of input.refImagePaths) imageParts.push(await imagePart(path));
  return buildOmniVideoRequestBodySync(model, input, imageParts);
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return data.error?.message ?? data.message ?? `gemini-omni failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `gemini-omni failed (${response.status})`;
  }
}

async function probeVideo(file: string): Promise<{ durationSeconds: number; width?: number; height?: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
    ]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(output) as {
          streams?: Array<{ width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const durationSeconds = Number(parsed.format?.duration);
        if (code !== 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error();
        resolvePromise({
          durationSeconds,
          width: parsed.streams?.[0]?.width,
          height: parsed.streams?.[0]?.height,
        });
      } catch {
        reject(new Error('unable to probe gemini-omni video'));
      }
    });
  });
}

/** Persist base64 MP4 into the project upload dir and return a media-pool path. */
export async function saveOmniVideoBytes(data: string): Promise<string> {
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new Error('gemini-omni returned empty video bytes');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.mp4`;
  const file = join(dir, filename);
  const partial = join(dir, `.${filename}.part`);
  try {
    await writeFile(partial, bytes);
    if ((await stat(partial)).size === 0) throw new Error('gemini-omni returned empty video');
    await probeVideo(partial);
    await rename(partial, file);
    return `/media/uploads/${filename}`;
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Poll a Files API result until Google finishes processing it; returns its download URL. */
async function activeFileDownloadUrl(baseUrl: string, apiKey: string, fileId: string): Promise<string> {
  const deadline = Date.now() + FILE_WAIT_MS;
  while (Date.now() < deadline) {
    const response = await fetchWithProxy(`${baseUrl}/v1beta/files/${fileId}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(await providerError(response));
    const file = await response.json() as { state?: string; error?: { message?: string } };
    if (file.state === 'ACTIVE') return `${baseUrl}/v1beta/files/${fileId}:download?alt=media`;
    if (file.state === 'FAILED') throw new Error(file.error?.message ?? 'gemini-omni video processing failed');
    await wait(FILE_POLL_MS);
  }
  throw new Error('gemini-omni video processing timed out');
}

function inlineTaskId(result: Record<string, unknown>, model: string, input: ValidVideoRequest): string {
  if (typeof result.id === 'string' && result.id) return result.id;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ model, prompt: input.prompt, ratio: input.ratio }))
    .digest('hex')
    .slice(0, 24);
  return `inline:${fingerprint}`;
}

/**
 * Run one Omni generation. Returns the Files API download URL (fetched with
 * geminiOmniResultFetch), another HTTPS URI, or an already-local
 * `/media/uploads/…` path when the API returned inline base64.
 */
export async function generateGeminiOmniVideo(
  input: ValidVideoRequest,
  options: GeminiOmniVideoOptions,
  registerProviderTask: RegisterGenerationProviderTask,
  existingTaskId?: string,
): Promise<string> {
  if (!options.geminiApiKey) {
    throw new Error('Gemini Omni is not configured. Set GEMINI_API_KEY in .env.local or Settings.');
  }
  const baseUrl = options.geminiBaseUrl.replace(/\/$/, '');
  const model = options.geminiOmniVideoModel.trim() || DEFAULT_OMNI_MODEL;

  // The interaction itself is synchronous (store=false), so only the file
  // processing step can resume; anything earlier would bill a new generation.
  if (existingTaskId) {
    if (!existingTaskId.startsWith(FILE_TASK_PREFIX)) {
      throw new Error('gemini-omni jobs cannot resume after interruption; submit a new generation');
    }
    return activeFileDownloadUrl(baseUrl, options.geminiApiKey, existingTaskId.slice(FILE_TASK_PREFIX.length));
  }

  const body = await buildOmniVideoRequestBody(input, model);
  const response = await fetchWithProxy(`${baseUrl}/v1beta/interactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': options.geminiApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok) throw new Error(await providerError(response));
  const result = await response.json() as Record<string, unknown>;
  const video = extractOmniVideo(result);
  const fileId = video.uri ? omniFileId(video.uri) : undefined;
  await registerProviderTask('gemini-omni', fileId ? `${FILE_TASK_PREFIX}${fileId}` : inlineTaskId(result, model, input));

  if (fileId) return activeFileDownloadUrl(baseUrl, options.geminiApiKey, fileId);
  if (video.uri) return video.uri;
  if (video.data) return saveOmniVideoBytes(video.data);
  throw new Error('gemini-omni returned no video');
}

/**
 * Result download for Omni: the Files API download needs the API key, which is
 * sent only to the configured Gemini origin. Redirects (to Google storage) are
 * followed by hand so the key never leaves that origin.
 */
export function geminiOmniResultFetch(options: Pick<GeminiOmniVideoOptions, 'geminiBaseUrl' | 'geminiApiKey'>) {
  const keyOrigin = new URL(options.geminiBaseUrl).origin;
  return async (input: string | URL, init: { signal: AbortSignal }): Promise<Response> => {
    let url = new URL(String(input));
    for (let hop = 0; hop < 5; hop += 1) {
      const headers: Record<string, string> = url.origin === keyOrigin ? { 'x-goog-api-key': options.geminiApiKey } : {};
      const response = await fetchWithProxy(url, { headers, redirect: 'manual', signal: init.signal });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) return response;
      await response.body?.cancel().catch(() => undefined);
      url = new URL(location, url);
    }
    throw new Error('gemini-omni video download redirected too many times');
  };
}

/** True when saveVideoResults can treat the value as an already-persisted upload. */
export function isLocalUploadPath(url: string): boolean {
  return url.startsWith('/media/uploads/')
    && isSafeUploadName(url.slice('/media/uploads/'.length).split(/[?#]/, 1)[0] ?? '');
}

export async function localUploadVideoMeta(path: string): Promise<{ path: string; durationSeconds: number; width?: number; height?: number }> {
  const file = localUploadFile(path);
  return { path, ...await probeVideo(file) };
}
