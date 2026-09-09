import assert from 'node:assert/strict';
import { seedKeystore } from '../keystore.ts';
import { generateFalCatalogImage, generateFalVideo } from './fal-client.ts';
import { validateVideoRequest } from './video-validation.ts';

await assert.rejects(generateFalCatalogImage({ falModel: 'nano-banana-2', prompt: 'test', count: 1, resolution: '1K', imageUrls: [] }), /FAL_KEY/);
seedKeystore({ FAL_KEY: 'local-test-credential-not-real' });
const originalFetch = globalThis.fetch;
const submitted: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = async (resource, init) => {
  const url = String(resource);
  assert.equal(new URL(url).hostname, 'queue.fal.run', 'SDK requests must go only to the official queue host');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Key local-test-credential-not-real');
  if (init?.method?.toUpperCase() === 'POST') {
    submitted.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ request_id: 'mock-request' });
  }
  if (url.includes('/status')) return Response.json({ status: 'COMPLETED' });
  return Response.json({ images: [{ url: 'https://fal.media/mock.png' }], video: { url: 'https://fal.media/mock.mp4' } });
};
try {
  const images = await generateFalCatalogImage({ falModel: 'nano-banana-2', prompt: 'test', count: 1, aspectRatio: '1:1', resolution: '1K', imageUrls: [] });
  assert.equal(images[0].url, 'https://fal.media/mock.png');
  assert.equal(submitted[0].url, 'https://queue.fal.run/fal-ai/nano-banana-2');
  assert.equal(submitted[0].body.resolution, '1K');
  let checkpoint = '';
  const input = validateVideoRequest({ model: 'fal', falModel: 'seedance-2.5', prompt: 'test', durationSeconds: 5 });
  assert.equal(await generateFalVideo(input, async (provider, id) => { assert.equal(provider, 'fal'); checkpoint = id; }), 'https://fal.media/mock.mp4');
  assert.equal(submitted[1].url, 'https://queue.fal.run/bytedance/seedance-2.5/text-to-video');
  assert.equal(submitted[1].body.duration, '5');
  await generateFalVideo({ ...input, falModel: 'different-setting-after-submit' }, async () => { throw new Error('resume must not submit'); }, checkpoint);
  assert.equal(submitted.length, 2);
  assert.throws(() => validateVideoRequest({ ...input, seed: 10 }), /seed/);
  assert.equal(submitted.length, 2, 'unsupported controls must not incur a charge');
  await assert.rejects(generateFalCatalogImage({ falModel: 'not-a-model', prompt: 'test', imageUrls: ['/missing/reference.png'] }), /model/i);
  assert.equal(submitted.length, 2, 'unknown model must reject before reference upload or submission');
} finally { globalThis.fetch = originalFetch; }
console.log('Official Fal SDK transport verified; all network mocked, no credits spent');
