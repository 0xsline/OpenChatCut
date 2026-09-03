import { proxyDispatcher } from '../outbound-proxy.ts';
import type { RegisterGenerationProviderTask } from './generation-jobs.ts';
import { mediaDataUrl } from './video-media.ts';
import type { ValidVideoRequest } from './video-validation.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);
const FAILURES = new Set(['failed', 'error', 'cancelled', 'canceled', 'expired']);
const SUCCESSES = new Set(['completed', 'succeeded']);
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

interface OfoxVideoOptions {
  ofoxBaseUrl: string;
  ofoxApiKey: string;
  ofoxVideoModel: string;
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; error?: { message?: string } };
    return data.error?.message ?? data.message ?? `video provider failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `video provider failed (${response.status})`;
  }
}

interface OfoxMediaRef {
  type: 'image_url';
  image_url: { url: string };
  frame_type?: 'first_frame' | 'last_frame';
}

/** Frame anchors and image references both ride as data URLs; the OFox
 * gateway re-hosts data URIs on its own object storage before handing the
 * request to the upstream model (verified live), so local project media
 * needs no public hosting. frame_images and input_references are mutually
 * exclusive at the API level; validation enforces that before submission. */
async function ofoxMediaInputs(input: ValidVideoRequest): Promise<{
  frame_images?: OfoxMediaRef[];
  input_references?: OfoxMediaRef[];
}> {
  if (input.firstFramePath) {
    const frames: OfoxMediaRef[] = [{
      type: 'image_url',
      image_url: { url: await mediaDataUrl(input.firstFramePath) },
      frame_type: 'first_frame',
    }];
    if (input.lastFramePath) {
      frames.push({
        type: 'image_url',
        image_url: { url: await mediaDataUrl(input.lastFramePath) },
        frame_type: 'last_frame',
      });
    }
    return { frame_images: frames };
  }
  if (input.refImagePaths.length) {
    return {
      input_references: await Promise.all(input.refImagePaths.map(async (path) => ({
        type: 'image_url' as const,
        image_url: { url: await mediaDataUrl(path) },
      }))),
    };
  }
  return {};
}

/** OFox multi-model video gateway: asynchronous task id plus polling.
 * POST /videos -> { id } ; GET /videos/{id} -> { status, unsigned_urls }.
 * Invalid duration/resolution/model values are rejected by the API with a
 * clear 400 before any task is created, so no per-model limits are kept here. */
export async function generateOfoxVideo(
  input: ValidVideoRequest,
  options: OfoxVideoOptions,
  registerProviderTask: RegisterGenerationProviderTask,
  existingTaskId?: string,
): Promise<string> {
  const baseUrl = options.ofoxBaseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${options.ofoxApiKey}` };
  let taskId = existingTaskId;
  if (!taskId) {
    const startedResponse = await fetchWithProxy(`${baseUrl}/videos`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: options.ofoxVideoModel, prompt: input.prompt,
        duration: input.durationSeconds, aspect_ratio: input.ratio,
        resolution: input.resolution ?? '720p',
        ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(await ofoxMediaInputs(input)),
      }),
      // Data-URL payloads carry whole reference images; give the submit
      // request a proportionally larger timeout than the text-only case.
      signal: AbortSignal.timeout(120_000),
    });
    if (!startedResponse.ok) throw new Error(await providerError(startedResponse));
    const started = await startedResponse.json() as { id?: unknown };
    taskId = String(started.id ?? '');
    if (!taskId) throw new Error('ofox did not return a task id');
    await registerProviderTask('ofox', taskId);
  }
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const poll = await fetchWithProxy(`${baseUrl}/videos/${encodeURIComponent(taskId)}`, {
      headers, signal: AbortSignal.timeout(20_000),
    });
    if (!poll.ok) throw new Error(await providerError(poll));
    const current = await poll.json() as { status?: unknown; unsigned_urls?: unknown; error?: { message?: unknown } };
    const status = String(current.status ?? '');
    if (SUCCESSES.has(status)) {
      // Prefer mirror_urls (persistent signed CDN addresses, present only when
      // the upstream has mirroring enabled) and fall back to unsigned_urls
      // (temporary upstream links that may expire within 24 hours).
      const body = current as { mirror_urls?: unknown; unsigned_urls?: unknown };
      for (const field of ['mirror_urls', 'unsigned_urls'] as const) {
        const urls = Array.isArray(body[field]) ? body[field] as unknown[] : [];
        const url = urls.find((item): item is string => typeof item === 'string' && /^https?:\/\//.test(item));
        if (url) return url;
      }
      throw new Error('ofox generation succeeded without a video URL');
    }
    if (FAILURES.has(status)) {
      const detail = typeof current.error?.message === 'string' ? `: ${current.error.message}` : '';
      throw new Error(`ofox generation ${status}${detail}`);
    }
    await wait(3_000);
  }
  throw new Error('ofox generation timed out');
}
