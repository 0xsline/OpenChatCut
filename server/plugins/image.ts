import { proxyDispatcher } from '../outbound-proxy.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Plugin } from 'vite';
import { generateImage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { presignGetUpload, putUploadFile } from '../r2.ts';
import { fetchGeneratedResult } from './result-download.ts';
// Proxy-aware fetch: attaches the configured outbound proxy (keystore
// PROXY_URL or HTTPS_PROXY/HTTP_PROXY env) via undici dispatcher.
type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

const ASPECTS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9']);
const SIZES = new Set(['512px', '1K', '2K', '4K']);
const QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);
const BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);
const MODERATIONS = new Set(['low', 'auto']);
const INPUT_FIDELITIES = new Set(['low', 'high']);

interface ImagePluginOptions {
  baseUrl: string;
  apiKey: string;
  geminiBaseUrl: string;
  geminiApiKey: string;
  geminiModel: string;
  minimaxBaseUrl: string;
  minimaxApiKey: string;
  minimaxModel: string;
  waveSpeedBaseUrl: string;
  waveSpeedApiKey: string;
  waveSpeedModel: string;
  byteplusBaseUrl: string;
  byteplusApiKey: string;
  byteplusModel: string;
}

interface ImageRequest {
  model?: string;
  prompt?: string;
  aspectRatio?: string;
  imageSize?: string;
  width?: number;
  height?: number;
  quality?: string;
  count?: number;
  referencePaths?: string[];
  maskPath?: string;
  background?: string;
  moderation?: string;
  inputFidelity?: string;
  outputFormat?: string;
  outputCompression?: number;
  seed?: number;
  /** MiniMax image-01 only: prompt_optimizer (official default false). */
  promptOptimizer?: boolean;
}

export interface ValidImageRequest {
  model: 'gpt-image-2' | 'nano-banana' | 'image-01' | 'wavespeed' | 'byteplus';
  prompt: string;
  aspectRatio?: string;
  imageSize: string;
  width?: number;
  height?: number;
  quality: string;
  count: number;
  referencePaths: string[];
  maskPath?: string;
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'low' | 'auto';
  inputFidelity?: 'low' | 'high';
  outputFormat: 'png' | 'jpeg' | 'webp';
  outputCompression?: number;
  seed?: number;
  promptOptimizer?: boolean;
}

function customDimensions(input: ImageRequest, model: ValidImageRequest['model']) {
  const width = input.width;
  const height = input.height;
  if ((width == null) !== (height == null)) throw new Error('width and height must be provided together');
  if (width == null || height == null) return {};
  if (input.aspectRatio != null) throw new Error('custom width/height cannot be combined with aspectRatio');
  if (model === 'nano-banana') throw new Error('custom width/height are not supported by nano-banana');
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('width and height must be integers');
  const [minimum, maximum, divisor] = model === 'image-01' ? [512, 2048, 8] : [512, 3840, 16];
  if (width < minimum || width > maximum || height < minimum || height > maximum) {
    throw new Error(`${model} width and height must be between ${minimum} and ${maximum}`);
  }
  if (width % divisor || height % divisor) throw new Error(`${model} width and height must be divisible by ${divisor}`);
  const aspect = width / height;
  if (model === 'gpt-image-2' && (aspect < 1 / 3 || aspect > 3)) throw new Error('gpt-image-2 custom aspect ratio must be between 1:3 and 3:1');
  return { width, height };
}

function validateGptOptions(input: ImageRequest, hasReferences: boolean) {
  if (input.background != null && !BACKGROUNDS.has(input.background)) throw new Error('background must be transparent, opaque, or auto');
  if (input.moderation != null && !MODERATIONS.has(input.moderation)) throw new Error('moderation must be low or auto');
  if (input.inputFidelity != null && !INPUT_FIDELITIES.has(input.inputFidelity)) throw new Error('inputFidelity must be low or high');
  if (input.inputFidelity != null && !hasReferences) throw new Error('inputFidelity requires reference images');
  if (input.maskPath != null && !hasReferences) throw new Error('maskPath requires reference images');
  if (input.outputFormat != null && !OUTPUT_FORMATS.has(input.outputFormat)) throw new Error('outputFormat must be png, jpeg, or webp');
  if (input.outputCompression != null && (!Number.isInteger(input.outputCompression) || input.outputCompression < 0 || input.outputCompression > 100)) {
    throw new Error('outputCompression must be an integer between 0 and 100');
  }
  if (input.outputCompression != null && (input.outputFormat ?? 'png') === 'png') {
    throw new Error('outputCompression requires outputFormat jpeg or webp');
  }
}

function rejectForeignImageOptions(input: ImageRequest, model: ValidImageRequest['model']) {
  if (model !== 'gpt-image-2') {
    const gptOnly = [input.maskPath, input.background, input.moderation, input.inputFidelity, input.outputFormat, input.outputCompression, input.quality];
    if (gptOnly.some((value) => value != null)) throw new Error(`GPT Image options are not supported by ${model}`);
  }
  if (model !== 'image-01' && input.promptOptimizer != null) {
    throw new Error('promptOptimizer is supported by image-01 (MiniMax) only');
  }
  if (model !== 'image-01' && input.seed != null) throw new Error('seed is supported by image-01 (MiniMax) only');
}

/** Pure request validation — exported for unit checks. */
export function validateImageRequest(input: ImageRequest): ValidImageRequest {
  const model = String(input.model ?? 'gpt-image-2');
  if (model !== 'gpt-image-2' && model !== 'nano-banana' && model !== 'image-01' && model !== 'wavespeed' && model !== 'byteplus') {
    throw new Error(`unsupported model ${model}`);
  }
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt is required');
  const dimensions = customDimensions(input, model);
  const aspectRatio = dimensions.width ? undefined : String(input.aspectRatio ?? '16:9');
  const imageSize = String(input.imageSize ?? '1K');
  const quality = String(input.quality ?? 'high');
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('count must be an integer between 1 and 10');
  if (aspectRatio && !ASPECTS.has(aspectRatio)) throw new Error(`unsupported aspect ratio ${aspectRatio}`);
  if (!SIZES.has(imageSize)) throw new Error(`unsupported image size ${imageSize}`);
  if (!QUALITIES.has(quality)) throw new Error(`unsupported quality ${quality}`);
  const referencePaths = input.referencePaths ?? [];
  const referenceLimit = model === 'nano-banana' ? 14 : model === 'gpt-image-2' ? 16 : model === 'image-01' ? 1 : 0;
  // wavespeed and byteplus (Seedream) are text-to-image only in this integration; no reference-image support yet.
  if (referencePaths.length > referenceLimit) {
    throw new Error(`too many reference images for ${model}`);
  }
  rejectForeignImageOptions(input, model);
  if (model === 'image-01') {
    if (prompt.length > 1500) throw new Error('image-01 prompt must be at most 1500 characters');
    if (count > 9) throw new Error('image-01 supports at most 9 images per call');
    if (aspectRatio === '4:5' || aspectRatio === '5:4') throw new Error(`image-01 does not support aspect ratio ${aspectRatio}`);
    if (input.promptOptimizer !== undefined && typeof input.promptOptimizer !== 'boolean') {
      throw new Error('promptOptimizer must be a boolean');
    }
    if (input.seed != null && !Number.isSafeInteger(input.seed)) throw new Error('seed must be a safe integer');
  } else if (model === 'gpt-image-2') {
    if (prompt.length > 32_000) throw new Error('gpt-image-2 prompt must be at most 32000 characters');
    if (imageSize === '512px') throw new Error('gpt-image-2 imageSize must be 1K, 2K, or 4K');
    validateGptOptions(input, referencePaths.length > 0);
  }
  return {
    model,
    prompt,
    aspectRatio,
    imageSize,
    ...dimensions,
    quality,
    count,
    referencePaths,
    maskPath: input.maskPath,
    background: input.background as ValidImageRequest['background'],
    moderation: input.moderation as ValidImageRequest['moderation'],
    inputFidelity: input.inputFidelity as ValidImageRequest['inputFidelity'],
    outputFormat: (input.outputFormat ?? 'png') as ValidImageRequest['outputFormat'],
    outputCompression: input.outputCompression,
    seed: input.seed,
    promptOptimizer: input.promptOptimizer,
  };
}

interface ProviderImage {
  b64_json?: string;
  url?: string;
}

async function readJson(req: IncomingMessage): Promise<ImageRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ImageRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function dimensions(aspectRatio: string, imageSize: string): [number, number] {
  const [rw, rh] = aspectRatio.split(':').map(Number);
  const longEdge = imageSize === '4K' ? 3840 : imageSize === '2K' ? 2048 : imageSize === '512px' ? 512 : 1536;
  const landscape = rw >= rh;
  const width = landscape ? longEdge : Math.round(longEdge * rw / rh / 16) * 16;
  const height = landscape ? Math.round(longEdge * rh / rw / 16) * 16 : longEdge;
  return [width, height];
}

function localAssetPath(path: string): string {
  if (!path.startsWith('/media/uploads/')) throw new Error('reference asset must be under /media/uploads/');
  const name = path.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid reference asset path');
  const file = resolveUploadFile(name);  // Customized directories take priority, and the old default directories are ignored.
  if (!file) throw new Error(`reference asset not found: ${name}`);
  return file;
}

async function providerError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `image provider failed (${response.status})`;
}

interface GptImageInput {
  model: string;
  prompt: string;
  quality: string;
  count: number;
  size: string;
  referencePaths: string[];
  maskPath?: string;
  background?: string;
  moderation?: string;
  inputFidelity?: string;
  outputFormat: string;
  outputCompression?: number;
}

function appendGptOptions(target: FormData | Record<string, unknown>, body: GptImageInput) {
  const set = (key: string, value: unknown) => {
    if (value == null) return;
    if (target instanceof FormData) target.set(key, String(value));
    else target[key] = value;
  };
  set('background', body.background);
  set('moderation', body.moderation);
  set('input_fidelity', body.inputFidelity);
  set('output_format', body.outputFormat);
  set('output_compression', body.outputCompression);
}

async function appendImageFile(form: FormData, field: string, path: string, filename: string) {
  const file = localAssetPath(path);
  const bytes = await readFile(file);
  const ext = extname(file).slice(1).toLowerCase() || 'png';
  form.append(field, new Blob([bytes], { type: imageMimeType(file) }), `${filename}.${ext}`);
}

/** OpenAI Images via the AI SDK for the plain text-to-image path — the SDK
 * owns body construction and error shapes; gpt options map onto the openai
 * provider metadata (quality/background/moderation/input_fidelity/
 * output_format/output_compression). The edits path (reference images +
 * mask) keeps the hand-rolled multipart call below. */
async function callOpenaiViaSdk(baseUrl: string, apiKey: string, body: GptImageInput): Promise<ProviderImage[]> {
  // The AI SDK appends the API path directly to baseURL (no implicit version
  // segment). The legacy hand-rolled call always added /v1, and the official
  // default baseURL carries it too — mirror that for custom endpoints.
  const base = /\/v\d+\/?$/i.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/v1`;
  const openai = createOpenAI({ apiKey, baseURL: base });
  const { images } = await generateImage({
    model: openai.image(body.model),
    prompt: body.prompt,
    n: body.count,
    size: body.size as `${number}x${number}`,
    maxRetries: 0,
    providerOptions: {
      openai: {
        quality: body.quality,
        ...(body.background ? { background: body.background } : {}),
        ...(body.moderation ? { moderation: body.moderation } : {}),
        ...(body.inputFidelity ? { inputFidelity: body.inputFidelity } : {}),
        ...(body.outputFormat ? { outputFormat: body.outputFormat } : {}),
        ...(body.outputCompression != null ? { outputCompression: body.outputCompression } : {}),
      },
    },
  });
  return images.map((image) => ({ b64_json: image.base64 }));
}

async function callProvider(baseUrl: string, apiKey: string, body: GptImageInput): Promise<ProviderImage[]> {
  if (!body.referencePaths.length) return callOpenaiViaSdk(baseUrl, apiKey, body);
  const endpoint = '/v1/images/edits';
  let requestBody: string | FormData;
  let headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };

  if (body.referencePaths.length) {
    const form = new FormData();
    form.set('model', body.model);
    form.set('prompt', body.prompt);
    form.set('quality', body.quality);
    form.set('size', body.size);
    form.set('n', String(body.count));
    appendGptOptions(form, body);
    for (const path of body.referencePaths) {
      await appendImageFile(form, 'image[]', path, 'reference');
    }
    if (body.maskPath) await appendImageFile(form, 'mask', body.maskPath, 'mask');
    requestBody = form;
  } else {
    headers = { ...headers, 'Content-Type': 'application/json' };
    const json: Record<string, unknown> = { model: body.model, prompt: body.prompt, quality: body.quality, size: body.size, n: body.count };
    appendGptOptions(json, body);
    requestBody = JSON.stringify(json);
  }

  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}${endpoint}`, { method: 'POST', headers, body: requestBody });
  if (!response.ok) throw new Error(await providerError(response));
  const result = await response.json() as { data?: ProviderImage[] };
  if (!result.data?.length) throw new Error('image provider returned no images');
  return result.data;
}

function imageMimeType(file: string): string {
  const ext = extname(file).slice(1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext || 'png'}`;
}

async function callGeminiProvider(baseUrl: string, apiKey: string, model: string, body: Required<Pick<ImageRequest, 'prompt' | 'count'>> & { aspectRatio: string; imageSize: string; referencePaths: string[] }): Promise<ProviderImage[]> {
  const input: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mime_type: string }> = [
    { type: 'text', text: body.prompt },
  ];
  for (const path of body.referencePaths) {
    const file = localAssetPath(path);
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
          type: 'image',
          mime_type: 'image/png',
          aspect_ratio: body.aspectRatio,
          image_size: body.imageSize,
        },
      }),
    });
    if (!response.ok) throw new Error(await providerError(response));
    const result = await response.json() as { output_image?: { data?: string } };
    if (!result.output_image?.data) throw new Error('Nano Banana returned no image');
    return { b64_json: result.output_image.data };
  }));
}

interface MinimaxImageResponse {
  data?: { image_urls?: string[]; image_base64?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
}

async function callMinimaxProvider(baseUrl: string, apiKey: string, model: string, body: {
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
    model,
    prompt: body.prompt,
    n: body.count,
    response_format: 'url',
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
      type: 'character',
      image_file: await minimaxSubjectUrl(path),
    })));
  }
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}/v1/image_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw new Error(await providerError(response));
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
    if (WAVESPEED_TERMINAL_FAILURES.has(status)) throw new Error(result.data?.error || `WaveSpeed generation ${status}`);
  }
  throw new Error('WaveSpeed generation timed out');
}

async function callWaveSpeedProvider(baseUrl: string, apiKey: string, model: string, body: {
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

/** BytePlus ModelArk (Seedream): OpenAI-images-compatible, but the endpoint hangs directly off
 * the Ark base URL (no /v1 segment) unlike the default OpenAI path. */
async function callByteplusImageProvider(baseUrl: string, apiKey: string, model: string, body: {
  prompt: string;
  count: number;
  width: number;
  height: number;
}): Promise<ProviderImage[]> {
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, prompt: body.prompt, n: body.count, size: `${body.width}x${body.height}`, response_format: 'url',
    }),
  });
  if (!response.ok) throw new Error(await providerError(response));
  const result = await response.json() as { data?: ProviderImage[] };
  if (!result.data?.length) throw new Error('BytePlus returned no images');
  return result.data;
}

async function minimaxSubjectUrl(path: string): Promise<string> {
  const file = localAssetPath(path);
  const name = path.slice('/media/uploads/'.length).split(/[?#]/, 1)[0];
  await putUploadFile(name, file, imageMimeType(file));
  const signed = await presignGetUpload(name, 3600);
  if (!signed) {
    throw new Error('MiniMax reference images require configured R2 storage so the provider can fetch a temporary HTTPS URL');
  }
  return signed.downloadUrl;
}

const SAVED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

async function saveImage(image: ProviderImage, fallbackExt: string): Promise<string> {
  let bytes: Buffer;
  let ext = fallbackExt === 'jpeg' ? 'jpg' : fallbackExt;
  if (image.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
  else if (image.url) {
    const response = await fetchGeneratedResult(image.url, 'image');
    bytes = Buffer.from(await response.arrayBuffer());
    // URL downloads (e.g. MiniMax) are often jpeg — keep the real extension.
    const urlExt = extname(new URL(image.url).pathname).slice(1).toLowerCase();
    if (SAVED_IMAGE_EXTS.has(urlExt)) ext = urlExt;
  } else throw new Error('image provider returned neither bytes nor URL');

  if (!bytes.length) throw new Error('image provider returned an empty image');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(join(dir, filename), bytes);
  return `/media/uploads/${filename}`;
}

export function imageGenerationPlugin(options: ImagePluginOptions): Plugin {
  return {
    name: 'openchatcut-image-generation',
    configureServer(server) {
      server.middlewares.use('/generate/image', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validateImageRequest(await readJson(req));
          const {
            model, prompt, aspectRatio, imageSize, quality, count, referencePaths, maskPath,
            background, moderation, inputFidelity, outputFormat, outputCompression,
            seed, promptOptimizer,
          } = input;
          const [width, height] = input.width != null && input.height != null
            ? [input.width, input.height]
            : dimensions(aspectRatio!, imageSize);
          let images: ProviderImage[];
          if (model === 'nano-banana') {
            if (!options.geminiApiKey) throw new Error('Nano Banana is not configured. Set GEMINI_API_KEY in .env.local.');
            if (!aspectRatio) throw new Error('Nano Banana requires aspectRatio');
            images = await callGeminiProvider(options.geminiBaseUrl, options.geminiApiKey, options.geminiModel, {
              prompt, count, aspectRatio, imageSize, referencePaths,
            });
          } else if (model === 'image-01') {
            if (!options.minimaxApiKey) throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or 设置面板.');
            // aspect_ratio is passed straight through; imageSize/quality do not apply to MiniMax.
            // Actual MiniMax model id comes from settings (image-01 / image-01-live).
            images = await callMinimaxProvider(options.minimaxBaseUrl, options.minimaxApiKey, options.minimaxModel, {
              prompt, count, aspectRatio, width: input.width, height: input.height,
              seed, referencePaths, promptOptimizer,
            });
          } else if (model === 'wavespeed') {
            if (!options.waveSpeedApiKey) throw new Error('WaveSpeed is not configured. Set WAVESPEED_API_KEY in .env.local.');
            images = await callWaveSpeedProvider(options.waveSpeedBaseUrl, options.waveSpeedApiKey, options.waveSpeedModel, {
              prompt, count, width, height,
            });
          } else if (model === 'byteplus') {
            if (!options.byteplusApiKey) throw new Error('BytePlus is not configured. Set BYTEPLUS_API_KEY in .env.local.');
            images = await callByteplusImageProvider(options.byteplusBaseUrl, options.byteplusApiKey, options.byteplusModel, {
              prompt, count, width, height,
            });
          } else {
            if (!options.apiKey) throw new Error('Image generation is not configured. Set IMAGE_API_KEY or OPENAI_API_KEY in .env.local.');
            images = await callProvider(options.baseUrl, options.apiKey, {
              model, prompt, quality, count, size: `${width}x${height}`, referencePaths, maskPath,
              background, moderation, inputFidelity, outputFormat, outputCompression,
            });
          }
          const paths = await Promise.all(images.map((image) => saveImage(image, model === 'gpt-image-2' ? outputFormat : 'png')));
          const reportDimensions = model !== 'image-01' || input.width != null;
          sendJson(res, 200, { paths, ...(reportDimensions ? { width, height } : {}) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const detail = error instanceof Error && error.cause
            ? ` cause=${error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : JSON.stringify(error.cause)}`
            : '';
          server.config.logger.error(`[generate:image] ${message}${detail}`);
          if (!res.headersSent) sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
