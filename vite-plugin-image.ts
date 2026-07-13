import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

const UPLOAD_DIR = resolve(process.cwd(), 'public/media/uploads');
const ASPECTS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9']);
const SIZES = new Set(['1K', '2K', '4K']);
const QUALITIES = new Set(['low', 'medium', 'high', 'auto']);

interface ImagePluginOptions {
  baseUrl: string;
  apiKey: string;
  geminiBaseUrl: string;
  geminiApiKey: string;
  geminiModel: string;
}

interface ImageRequest {
  model?: string;
  prompt?: string;
  aspectRatio?: string;
  imageSize?: string;
  quality?: string;
  count?: number;
  referencePaths?: string[];
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
  const file = resolve(process.cwd(), `public${path}`);
  if (!file.startsWith(`${UPLOAD_DIR}/`)) throw new Error('invalid reference asset path');
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

async function saveImage(image: ProviderImage): Promise<string> {
  let bytes: Buffer;
  if (image.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
  else if (image.url) {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`generated image download failed (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else throw new Error('image provider returned neither bytes nor URL');

  if (!bytes.length) throw new Error('image provider returned an empty image');
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}.png`;
  await writeFile(join(UPLOAD_DIR, filename), bytes);
  return `/media/uploads/${filename}`;
}

export function imageGenerationPlugin(options: ImagePluginOptions): Plugin {
  return {
    name: 'chatcut-image-generation',
    configureServer(server) {
      server.middlewares.use('/generate/image', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = await readJson(req);
          const model = String(input.model ?? 'gpt-image-2');
          if (model !== 'gpt-image-2' && model !== 'nano-banana') throw new Error(`unsupported model ${model}`);
          const prompt = String(input.prompt ?? '').trim();
          if (!prompt) throw new Error('prompt is required');
          const aspectRatio = String(input.aspectRatio ?? '16:9');
          const imageSize = String(input.imageSize ?? '1K');
          const quality = String(input.quality ?? 'high');
          const count = Math.min(10, Math.max(1, Math.floor(Number(input.count) || 1)));
          if (!ASPECTS.has(aspectRatio)) throw new Error(`unsupported aspect ratio ${aspectRatio}`);
          if (!SIZES.has(imageSize)) throw new Error(`unsupported image size ${imageSize}`);
          if (!QUALITIES.has(quality)) throw new Error(`unsupported quality ${quality}`);
          const [width, height] = dimensions(aspectRatio, imageSize);
          const referencePaths = input.referencePaths ?? [];
          if (referencePaths.length > (model === 'nano-banana' ? 14 : 10)) throw new Error(`too many reference images for ${model}`);
          let images: ProviderImage[];
          if (model === 'nano-banana') {
            if (!options.geminiApiKey) throw new Error('Nano Banana is not configured. Set GEMINI_API_KEY in .env.local.');
            images = await callGeminiProvider(options.geminiBaseUrl, options.geminiApiKey, options.geminiModel, {
              prompt, count, aspectRatio, imageSize, referencePaths,
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
