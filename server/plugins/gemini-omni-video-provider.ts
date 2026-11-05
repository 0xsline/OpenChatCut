// Gemini Omni Flash (`gemini-omni-1.1-flash`) via the Interactions API.
// Same auth/header style as Nano Banana image generation (GEMINI_API_KEY).
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
  type OmniInputPart,
  type OmniVideoRequestBody,
} from './gemini-omni-video-helpers.ts';

export {
  extractOmniVideo,
  omniAspectRatio,
  omniPromptWithDuration,
  omniResolution,
  omniTask,
} from './gemini-omni-video-helpers.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

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

/**
 * Run one Omni generation. Returns either an HTTPS URI (for saveVideo download)
 * or an already-local `/media/uploads/…` path when the API returned inline base64.
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
  const model = options.geminiOmniVideoModel.trim() || 'gemini-omni-1.1-flash';

  // Resume of a completed sync call is not supported (store=false). If a task id
  // is present without a stored result URL, fail clearly instead of re-billing.
  if (existingTaskId) {
    throw new Error('gemini-omni jobs cannot resume after interruption; submit a new generation');
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
  const interactionId = typeof result.id === 'string' ? result.id : '';
  if (interactionId) {
    await registerProviderTask('gemini-omni', interactionId);
  } else {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ model, prompt: input.prompt, ratio: input.ratio }))
      .digest('hex')
      .slice(0, 24);
    await registerProviderTask('gemini-omni', `inline:${fingerprint}`);
  }

  const video = extractOmniVideo(result);
  if (video.uri) return video.uri;
  if (video.data) return saveOmniVideoBytes(video.data);
  throw new Error('gemini-omni returned no video');
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
