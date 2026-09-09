import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { seedKeystore } from '../keystore.ts';
import { imageGenerationPlugin, validateImageRequest } from './image.ts';
import { validateVideoRequest, validateSavedVideoRequest, falVideoCatalogInput } from './video-validation.ts';

// A configured Fal key must not redirect an explicitly chosen native provider.
seedKeystore({ FAL_KEY: 'mock-key-not-real', FAL_IMAGE_MODEL: 'nano-banana-2' });
let middleware: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
const plugin = imageGenerationPlugin({} as Parameters<typeof imageGenerationPlugin>[0]);
const configure = plugin.configureServer as (server: unknown) => void;
configure({ middlewares: { use: (_path: string, handler: typeof middleware) => { middleware = handler; } }, config: { logger: { error() {} } } });
const originalFetch = globalThis.fetch;
let calls = 0;
let requestedUrl = '';
globalThis.fetch = async (url) => { calls++; requestedUrl = String(url); return Response.json({ detail: 'Mock transport stopped before submission' }, { status: 400 }); };
try {
  const req = Object.assign(Readable.from([JSON.stringify({ model: 'nano-banana', prompt: 'test' })]), { method: 'POST' }) as IncomingMessage;
  let response = '';
  const res = { statusCode: 0, headersSent: false, setHeader() {}, end(body: string) { response = body; } } as unknown as ServerResponse;
  await middleware!(req, res);
  assert.match(JSON.parse(response).error, /GEMINI_API_KEY/);
  assert.equal(calls, 0);
  assert.throws(() => validateImageRequest({ model: 'fal', prompt: 'test' }), /Choose a Fal image model/);
  assert.throws(() => validateVideoRequest({ model: 'fal', prompt: 'test' }), /Choose a Fal video model/);
  assert.throws(() => validateImageRequest({ model: 'fal', falModel: 'nano-banana-2', prompt: 'test', width: 1024, height: 1024 }), /width/);
  const video = validateVideoRequest({ model: 'fal', falModel: 'seedance-2.5', prompt: 'test' });
  assert.equal(video.falModel, 'seedance-2.5');
  assert.equal(video.durationSpecified, false);
  assert.equal(video.ratioSpecified, false);
  const restored = validateSavedVideoRequest({ ...video, falModel: 'veo-3.1' });
  assert.equal(falVideoCatalogInput(restored).duration, undefined, 'retry retains the selected model default rather than persisting generic five seconds');
  assert.equal(falVideoCatalogInput(restored).aspectRatio, undefined);
  assert.equal(calls, 0, 'local validation must never call Fal');
  const falReq = Object.assign(Readable.from([JSON.stringify({ model: 'fal', prompt: 'test' })]), { method: 'POST' }) as IncomingMessage;
  await middleware!(falReq, res);
  assert.equal(requestedUrl, 'https://queue.fal.run/fal-ai/nano-banana-2', 'omitted falModel resolves the saved image default');
  assert.ok(calls > 0, 'explicit Fal request reached the mock transport');
} finally { globalThis.fetch = originalFetch; }
console.log('Fal opt-in routing and explicit selection validation verified (no network)');
