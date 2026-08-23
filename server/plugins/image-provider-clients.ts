import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { proxyDispatcher } from '../outbound-proxy.ts';
import { presignGetUpload, putUploadFile } from '../r2.ts';
import { xaiOauthAccessToken } from '../xai-oauth-session.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

export interface ProviderImage {
  b64_json?: string;
  url?: string;
}

export function localImageAssetPath(path: string): string {
  if (!path.startsWith('/media/uploads/')) throw new Error('reference asset must be under /media/uploads/');
  const name = path.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid reference asset path');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`reference asset not found: ${name}`);
  return file;
}

export function imageMimeType(file: string): string {
  const ext = extname(file).slice(1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext || 'png'}`;
}

export async function imageProviderError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `image provider failed (${response.status})`;
}

export async function callGeminiProvider(baseUrl: string, apiKey: string, model: string, body: {
  prompt: string;
  count: number;
  aspectRatio: string;
  imageSize: string;
  referencePaths: string[];
}): Promise<ProviderImage[]> {
  const input: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mime_type: string }> = [
    { type: 'text', text: body.prompt },
  ];
  for (const path of body.referencePaths) {
    const file = localImageAssetPath(path);
    input.push({ type: 'image', data: (await readFile(file)).toString('base64'), mime_type: imageMimeType(file) });
  }
  return Promise.all(Array.from({ length: body.count }, async () => {
    const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}/v1beta/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model,
        input,
        response_format: {
          type: 'image', mime_type: 'image/png',
          aspect_ratio: body.aspectRatio, image_size: body.imageSize,
        },
      }),
    });
    if (!response.ok) throw new Error(await imageProviderError(response));
    const result = await response.json() as { output_image?: { data?: string } };
    if (!result.output_image?.data) throw new Error('Nano Banana returned no image');
    return { b64_json: result.output_image.data };
  }));
}

interface MinimaxImageResponse {
  data?: { image_urls?: string[]; image_base64?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
}

async function minimaxSubjectUrl(path: string): Promise<string> {
  const file = localImageAssetPath(path);
  const name = path.slice('/media/uploads/'.length).split(/[?#]/, 1)[0];
  await putUploadFile(name, file, imageMimeType(file));
  const signed = await presignGetUpload(name, 3600);
  if (!signed) {
    throw new Error('MiniMax reference images require configured R2 storage so the provider can fetch a temporary HTTPS URL');
  }
  return signed.downloadUrl;
}

export async function callMinimaxProvider(baseUrl: string, apiKey: string, model: string, body: {
  prompt: string;
  count: number;
  aspectRatio?: string;
  width?: number;
  height?: number;
  seed?: number;
  referencePaths: string[];
  promptOptimizer?: boolean;
}): Promise<ProviderImage[]> {
  const requestBody: Record<string, unknown> = {
    model, prompt: body.prompt, n: body.count, response_format: 'url',
  };
  if (body.aspectRatio) requestBody.aspect_ratio = body.aspectRatio;
  if (body.width != null && body.height != null) {
    requestBody.width = body.width;
    requestBody.height = body.height;
  }
  if (body.seed != null) requestBody.seed = body.seed;
  if (body.promptOptimizer != null) requestBody.prompt_optimizer = body.promptOptimizer;
  if (body.referencePaths.length) {
    requestBody.subject_reference = await Promise.all(body.referencePaths.map(async (path) => ({
      type: 'character', image_file: await minimaxSubjectUrl(path),
    })));
  }
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}/v1/image_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw new Error(await imageProviderError(response));
  const result = await response.json() as MinimaxImageResponse;
  if (result.base_resp && result.base_resp.status_code !== 0) {
    throw new Error(result.base_resp.status_msg || `MiniMax image failed (${result.base_resp.status_code})`);
  }
  const images: ProviderImage[] = [
    ...(result.data?.image_urls ?? []).map((url) => ({ url })),
    ...(result.data?.image_base64 ?? []).map((b64) => ({ b64_json: b64 })),
  ];
  if (!images.length) throw new Error('MiniMax returned no images');
  return images;
}

interface WaveSpeedResult {
  data?: { id?: string; status?: string; outputs?: string[]; error?: string };
}

async function waveSpeedError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { message?: string; data?: { error?: string } } | null;
  return body?.data?.error ?? body?.message ?? `WaveSpeed request failed (${response.status})`;
}

const WAVESPEED_TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'timeout']);

async function waveSpeedPollResult(baseUrl: string, apiKey: string, taskId: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 2_000));
    const response = await fetchWithProxy(`${baseUrl}/api/v3/predictions/${encodeURIComponent(taskId)}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(await waveSpeedError(response));
    const result = await response.json() as WaveSpeedResult;
    const status = result.data?.status ?? '';
    if (status === 'completed') {
      const url = result.data?.outputs?.[0];
      if (!url) throw new Error('WaveSpeed completed without an output URL');
      return url;
    }
    if (WAVESPEED_TERMINAL_FAILURES.has(status)) {
      throw new Error(result.data?.error || `WaveSpeed generation ${status}`);
    }
  }
  throw new Error('WaveSpeed generation timed out');
}

export async function callWaveSpeedProvider(baseUrl: string, apiKey: string, model: string, body: {
  prompt: string;
  count: number;
  width: number;
  height: number;
}): Promise<ProviderImage[]> {
  const root = baseUrl.replace(/\/$/, '');
  return Promise.all(Array.from({ length: body.count }, async () => {
    const response = await fetchWithProxy(`${root}/api/v3/${model}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ prompt: body.prompt, size: `${body.width}*${body.height}` }),
    });
    if (!response.ok) throw new Error(await waveSpeedError(response));
    const submitted = await response.json() as WaveSpeedResult;
    const taskId = submitted.data?.id;
    if (!taskId) throw new Error('WaveSpeed did not return a task id');
    return { url: await waveSpeedPollResult(root, apiKey, taskId) };
  }));
}

export async function callByteplusImageProvider(baseUrl: string, apiKey: string, model: string, body: {
  prompt: string;
  count: number;
  width: number;
  height: number;
}): Promise<ProviderImage[]> {
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, prompt: body.prompt, n: body.count,
      size: `${body.width}x${body.height}`, response_format: 'url',
    }),
  });
  if (!response.ok) throw new Error(await imageProviderError(response));
  const result = await response.json() as { data?: ProviderImage[] };
  if (!result.data?.length) throw new Error('BytePlus returned no images');
  return result.data;
}

export async function callGrokImageProvider(baseUrl: string, apiKey: string, model: string, body: {
  prompt: string;
  count: number;
  aspectRatio?: string;
  imageSize: string;
}): Promise<ProviderImage[]> {
  const token = xaiOauthAccessToken() || apiKey;
  const payload: Record<string, unknown> = {
    model, prompt: body.prompt, n: body.count,
    aspect_ratio: body.aspectRatio,
    resolution: body.imageSize === '2K' ? '2k' : '1k',
    response_format: 'b64_json',
  };
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await imageProviderError(response));
  const result = await response.json() as { data?: ProviderImage[] };
  if (!result.data?.length) throw new Error('grok-imagine returned no images');
  return result.data;
}
