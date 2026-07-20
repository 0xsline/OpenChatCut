import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Plugin } from 'vite';

import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
const ASPECTS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9']);
const SIZES = new Set(['1K', '2K', '4K']);
const QUALITIES = new Set(['low', 'medium', 'high', 'auto']);

interface ImagePluginOptions {
  baseUrl: string;
  apiKey: string;
  geminiBaseUrl: string;
  geminiApiKey: string;
  geminiModel: string;
  minimaxBaseUrl: string;
  minimaxApiKey: string;
  minimaxModel: string;
}

interface ImageRequest {
  model?: string;
  prompt?: string;
  aspectRatio?: string;
  imageSize?: string;
  quality?: string;
  count?: number;
  referencePaths?: string[];
  /** MiniMax image-01 only: prompt_optimizer (default true). */
  promptOptimizer?: boolean;
}

export interface ValidImageRequest {
  model: 'gpt-image-2' | 'nano-banana' | 'image-01';
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  quality: string;
  count: number;
  referencePaths: string[];
  promptOptimizer?: boolean;
}

/** Pure request validation — exported for unit checks. */
export function validateImageRequest(input: ImageRequest): ValidImageRequest {
  const model = String(input.model ?? 'gpt-image-2');
  if (model !== 'gpt-image-2' && model !== 'nano-banana' && model !== 'image-01') {
    throw new Error(`unsupported model ${model}`);
  }
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt is required');
  const aspectRatio = String(input.aspectRatio ?? '16:9');
  const imageSize = String(input.imageSize ?? '1K');
  const quality = String(input.quality ?? 'high');
  const count = Math.min(10, Math.max(1, Math.floor(Number(input.count) || 1)));
  if (!ASPECTS.has(aspectRatio)) throw new Error(`unsupported aspect ratio ${aspectRatio}`);
  if (!SIZES.has(imageSize)) throw new Error(`unsupported image size ${imageSize}`);
  if (!QUALITIES.has(quality)) throw new Error(`unsupported quality ${quality}`);
  const referencePaths = input.referencePaths ?? [];
  if (referencePaths.length > (model === 'nano-banana' ? 14 : 10)) {
    throw new Error(`too many reference images for ${model}`);
  }
  if (model === 'image-01') {
    if (prompt.length > 1500) throw new Error('image-01 prompt must be at most 1500 characters');
    if (count > 9) throw new Error('image-01 supports at most 9 images per call');
    if (referencePaths.length) throw new Error('image-01 does not support reference images');
    if (input.promptOptimizer !== undefined && typeof input.promptOptimizer !== 'boolean') {
      throw new Error('promptOptimizer must be a boolean');
    }
  } else if (input.promptOptimizer !== undefined) {
    throw new Error('promptOptimizer is supported by image-01 (MiniMax) only');
  }
  return {
    model,
    prompt,
    aspectRatio,
    imageSize,
    quality,
    count,
    referencePaths,
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
  const longEdge = imageSize === '4K' ? 3840 : imageSize === '2K' ? 2048 : 1536;
  const landscape = rw >= rh;
  const width = landscape ? longEdge : Math.round(longEdge * rw / rh / 16) * 16;
  const height = landscape ? Math.round(longEdge * rh / rw / 16) * 16 : longEdge;
  return [width, height];
}

function localAssetPath(path: string): string {
  if (!path.startsWith('/media/uploads/')) throw new Error('reference asset must be under /media/uploads/');
  const name = path.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid reference asset path');
  const file = resolveUploadFile(name);  // 自定义目录优先,旧默认目录兜底
  if (!file) throw new Error(`reference asset not found: ${name}`);
  return file;
}

async function providerError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `image provider failed (${response.status})`;
}

async function callProvider(baseUrl: string, apiKey: string, body: Required<Pick<ImageRequest, 'model' | 'prompt' | 'quality' | 'count'>> & { size: string; referencePaths: string[] }): Promise<ProviderImage[]> {
  const endpoint = body.referencePaths.length ? '/v1/images/edits' : '/v1/images/generations';
  let requestBody: string | FormData;
  let headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };

  if (body.referencePaths.length) {
    const form = new FormData();
    form.set('model', body.model);
    form.set('prompt', body.prompt);
    form.set('quality', body.quality);
    form.set('size', body.size);
    form.set('n', String(body.count));
    form.set('output_format', 'png');
    for (const path of body.referencePaths) {
      const file = localAssetPath(path);
      const bytes = await readFile(file);
      const ext = extname(file).slice(1).toLowerCase() || 'png';
      form.append('image[]', new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }), `reference.${ext}`);
    }
    requestBody = form;
  } else {
    headers = { ...headers, 'Content-Type': 'application/json' };
    requestBody = JSON.stringify({ model: body.model, prompt: body.prompt, quality: body.quality, size: body.size, n: body.count, output_format: 'png' });
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${endpoint}`, { method: 'POST', headers, body: requestBody });
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
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1beta/interactions`, {
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
  aspectRatio: string;
  promptOptimizer?: boolean;
}): Promise<ProviderImage[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/image_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt: body.prompt,
      aspect_ratio: body.aspectRatio,
      n: body.count,
      response_format: 'url',
      // Official default true; false keeps the prompt more literal.
      prompt_optimizer: body.promptOptimizer !== false,
    }),
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

const SAVED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

async function saveImage(image: ProviderImage): Promise<string> {
  let bytes: Buffer;
  let ext = 'png';
  if (image.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
  else if (image.url) {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`generated image download failed (${response.status})`);
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
          const { model, prompt, aspectRatio, imageSize, quality, count, referencePaths, promptOptimizer } = input;
          const [width, height] = dimensions(aspectRatio, imageSize);
          let images: ProviderImage[];
          if (model === 'nano-banana') {
            if (!options.geminiApiKey) throw new Error('Nano Banana is not configured. Set GEMINI_API_KEY in .env.local.');
            images = await callGeminiProvider(options.geminiBaseUrl, options.geminiApiKey, options.geminiModel, {
              prompt, count, aspectRatio, imageSize, referencePaths,
            });
          } else if (model === 'image-01') {
            if (!options.minimaxApiKey) throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or 设置面板.');
            // aspect_ratio is passed straight through; imageSize/quality do not apply to MiniMax.
            // Actual MiniMax model id comes from settings (image-01 / image-01-live).
            images = await callMinimaxProvider(options.minimaxBaseUrl, options.minimaxApiKey, options.minimaxModel, {
              prompt, count, aspectRatio, promptOptimizer,
            });
          } else {
            if (!options.apiKey) throw new Error('Image generation is not configured. Set IMAGE_API_KEY or OPENAI_API_KEY in .env.local.');
            images = await callProvider(options.baseUrl, options.apiKey, {
              model, prompt, quality, count, size: `${width}x${height}`, referencePaths,
            });
          }
          const paths = await Promise.all(images.map(saveImage));
          sendJson(res, 200, { paths, width, height });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:image] ${message}`);
          if (!res.headersSent) sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
