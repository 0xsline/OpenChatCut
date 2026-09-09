import assert from 'node:assert/strict';
import {
  DEFAULT_FAL_IMAGE_MODEL_ID,
  DEFAULT_FAL_VIDEO_MODEL_ID,
  FAL_IMAGE_MODELS,
  FAL_MODELS,
  FAL_VIDEO_MODELS,
  falModelSummary,
  isFalEndpoint,
} from '../../shared/fal-models.ts';
import {
  buildFalCatalogImageRequest,
  buildFalCatalogVideoRequest,
} from './fal-catalog-input.ts';

assert.equal(DEFAULT_FAL_IMAGE_MODEL_ID, 'nano-banana-2');
assert.equal(DEFAULT_FAL_VIDEO_MODEL_ID, 'seedance-2.5');
assert.ok(FAL_IMAGE_MODELS.length >= 8, 'catalog should offer a useful image-model selection');
assert.ok(FAL_VIDEO_MODELS.length >= 8, 'catalog should offer a useful video-model selection');
assert.equal(new Set(FAL_MODELS.map((model) => model.id)).size, FAL_MODELS.length);
for (const model of FAL_MODELS) {
  assert.ok(model.label.length > 2);
  assert.match(model.docsUrl, /^https:\/\/fal\.ai\//);
  assert.ok(falModelSummary(model).includes(model.label));
  for (const endpoint of Object.values(model.endpoints)) assert.equal(isFalEndpoint(endpoint), true);
}
for (const model of FAL_IMAGE_MODELS) {
  const request = buildFalCatalogImageRequest({ falModel: model.id, prompt: 'Catalog smoke test' });
  assert.equal(isFalEndpoint(request.endpoint), true);
}
for (const model of FAL_VIDEO_MODELS) {
  const request = buildFalCatalogVideoRequest({ falModel: model.id, prompt: 'Catalog smoke test' });
  assert.equal(isFalEndpoint(request.endpoint), true);
}
assert.equal(isFalEndpoint('https://attacker.invalid/steal-key'), false);
assert.equal(isFalEndpoint('fal-ai/nano-banana-2/unknown'), false);
const veoSummary = falModelSummary('veo-3.1');
assert.match(veoSummary, /durations 4\/6\/8s/);
assert.match(veoSummary, /default .*8s/);
const o3Summary = falModelSummary('kling-o3-standard');
assert.match(o3Summary, /up to 4 image refs/);
assert.match(o3Summary, /reference mode/);
assert.doesNotMatch(o3Summary, /first frame/);

assert.deepEqual(buildFalCatalogImageRequest({
  falModel: 'nano-banana-2', prompt: 'A red paper boat', count: 2,
  aspectRatio: '16:9', resolution: '0.5K', imageUrls: [],
}), {
  endpoint: 'fal-ai/nano-banana-2',
  input: {
    prompt: 'A red paper boat', num_images: 2, aspect_ratio: '16:9',
    resolution: '0.5K', output_format: 'png', limit_generations: true,
  },
});
assert.deepEqual(buildFalCatalogImageRequest({
  falModel: 'nano-banana-pro', prompt: 'Put the boat at sunset', imageUrls: ['image-a'],
}), {
  endpoint: 'fal-ai/nano-banana-pro/edit',
  input: {
    prompt: 'Put the boat at sunset', num_images: 1, aspect_ratio: 'auto',
    resolution: '1K', output_format: 'png', image_urls: ['image-a'],
  },
});
assert.deepEqual(buildFalCatalogImageRequest({
  falModel: 'gpt-image-2', prompt: 'Editorial portrait', aspectRatio: '4:3',
}), {
  endpoint: 'openai/gpt-image-2',
  input: { prompt: 'Editorial portrait', image_size: 'landscape_4_3', quality: 'high', num_images: 1, output_format: 'png' },
});
for (const [aspectRatio, width, height] of [
  ['1:1', 1024, 1024], ['16:9', 1408, 792], ['9:16', 792, 1408],
  ['4:3', 1216, 912], ['3:4', 912, 1216],
] as const) {
  const request = buildFalCatalogImageRequest({
    falModel: 'seedream-5-pro', prompt: 'A red paper boat', resolution: '1K', aspectRatio,
  });
  assert.deepEqual(request.input.image_size, { width, height });
  assert.ok(width * height >= 1024 * 1024 && width * height <= 2048 * 2048);
}
const seedreamEdit = buildFalCatalogImageRequest({
  falModel: 'seedream-5-pro', prompt: 'A multilingual poster', resolution: '2K',
  aspectRatio: '16:9', imageUrls: ['one', 'two'],
});
assert.equal(seedreamEdit.endpoint, 'bytedance/seedream/v5/pro/edit');
assert.deepEqual(seedreamEdit.input.image_size, { width: 2048, height: 1152 });
assert.deepEqual(buildFalCatalogImageRequest({
  falModel: 'ideogram-4', prompt: 'Poster saying HELLO', aspectRatio: '9:16', count: 2,
}), {
  endpoint: 'ideogram/v4',
  input: { prompt: 'Poster saying HELLO', image_size: 'portrait_16_9', num_images: 2, output_format: 'png' },
});
assert.throws(() => buildFalCatalogImageRequest({ falModel: 'flux-2', prompt: 'x', imageUrls: ['x'] }), /reference images/i);
assert.throws(() => buildFalCatalogImageRequest({ falModel: 'nano-banana-2', prompt: 'x', count: 5 }), /at most 4/i);
assert.throws(() => buildFalCatalogImageRequest({ falModel: 'seedance-2.5', prompt: 'x' }), /image model/i);

assert.deepEqual(buildFalCatalogVideoRequest({
  falModel: 'seedance-2.5', prompt: 'A paper boat floats', duration: 12,
  resolution: '720p', aspectRatio: '16:9', generateAudio: false,
}), {
  endpoint: 'bytedance/seedance-2.5/text-to-video',
  input: { prompt: 'A paper boat floats', duration: '12', resolution: '720p', aspect_ratio: '16:9', generate_audio: false },
});
assert.deepEqual(buildFalCatalogVideoRequest({
  falModel: 'seedance-2.5', prompt: 'Animate the boat', firstFrame: 'first', lastFrame: 'last',
}), {
  endpoint: 'bytedance/seedance-2.5/image-to-video',
  input: { prompt: 'Animate the boat', duration: '5', resolution: '720p', aspect_ratio: 'auto', generate_audio: true, image_url: 'first', end_image_url: 'last' },
});
const seedanceRefs = buildFalCatalogVideoRequest({
  falModel: 'seedance-2.5', prompt: 'Use Image 1 and Video 1', imageUrls: ['image'],
  videoUrls: ['video'], audioUrls: ['audio'],
});
assert.equal(seedanceRefs.endpoint, 'bytedance/seedance-2.5/reference-to-video');
assert.deepEqual(seedanceRefs.input.image_urls, ['image']);
assert.deepEqual(seedanceRefs.input.video_urls, ['video']);
assert.deepEqual(seedanceRefs.input.audio_urls, ['audio']);

assert.deepEqual(buildFalCatalogVideoRequest({
  falModel: 'kling-v3-pro', prompt: 'Slow camera orbit', firstFrame: 'first', duration: 8,
  generateAudio: true,
}), {
  endpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
  input: { prompt: 'Slow camera orbit', duration: '8', generate_audio: true, start_image_url: 'first' },
});
assert.equal(buildFalCatalogVideoRequest({
  falModel: 'kling-o3-standard', prompt: 'Keep Image 1 consistent', imageUrls: ['one'],
}).endpoint, 'fal-ai/kling-video/o3/standard/reference-to-video');
assert.deepEqual(buildFalCatalogVideoRequest({
  falModel: 'veo-3.1-fast', prompt: 'Cloud timelapse', duration: 6, aspectRatio: '9:16',
}), {
  endpoint: 'fal-ai/veo3.1/fast',
  input: { prompt: 'Cloud timelapse', duration: '6s', resolution: '720p', aspect_ratio: '9:16', generate_audio: true },
});
assert.deepEqual(buildFalCatalogVideoRequest({
  falModel: 'wan-3.0', prompt: 'Wind moves the grass', firstFrame: 'first', lastFrame: 'last',
  duration: 5, generateAudio: false,
}), {
  endpoint: 'alibaba/wan-3.0/image-to-video',
  input: { prompt: 'Wind moves the grass', duration: 5, resolution: '1080p', aspect_ratio: 'adaptive', audio: false, start_image_url: 'first', end_image_url: 'last' },
});
assert.deepEqual(buildFalCatalogVideoRequest({
  falModel: 'minimax-h3-max', prompt: 'A cat runs through flowers', duration: 10,
}), {
  endpoint: 'minimax/h3-max/text-to-video',
  input: { prompt: 'A cat runs through flowers', duration: 10, resolution: '768P', aspect_ratio: '16:9', prompt_expansion_mode: 'balanced' },
});
assert.deepEqual(buildFalCatalogVideoRequest({
  falModel: 'pixverse-v6', prompt: 'A kinetic sports shot', duration: 8, resolution: '1080p',
  generateAudio: true,
}), {
  endpoint: 'fal-ai/pixverse/v6/text-to-video',
  input: { prompt: 'A kinetic sports shot', duration: 8, resolution: '1080p', aspect_ratio: '16:9', generate_audio_switch: true },
});
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'veo-3.1', prompt: 'x', duration: 5 }), /duration/i);
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'pixverse-v6', prompt: 'x', resolution: '4k' }), /resolution/i);
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'minimax-h3-max', prompt: 'x', audioUrls: ['audio'] }), /audio.*reference/i);
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'seedance-2.5', prompt: 'x', firstFrame: 'first', videoUrls: ['video'] }), /first frame.*reference/i);
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'seedance-2.5', prompt: 'x', imageUrls: 'bad' as unknown as string[] }), /array/i);
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'seedance-2.5', prompt: 'x', generateAudio: 'yes' as unknown as boolean }), /boolean/i);
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'nano-banana-2', prompt: 'x' }), /video model/i);
assert.throws(() => buildFalCatalogVideoRequest({ falModel: 'missing', prompt: 'x' }), /unknown Fal model/i);

console.log('Fal catalog and pure input adapters verified (no network calls)');
