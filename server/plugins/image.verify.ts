import assert from 'node:assert/strict';
import { validateImageRequest } from './image.ts';

const basic = validateImageRequest({ prompt: 'a cat' });
assert.equal(basic.model, 'gpt-image-2');
assert.equal(basic.aspectRatio, '16:9');
assert.equal(basic.count, 1);

const mm = validateImageRequest({
  model: 'image-01',
  prompt: 'matte bottle',
  count: 3,
  seed: 42,
  width: 1024,
  height: 1536,
  referencePaths: ['/media/uploads/a.jpg'],
  promptOptimizer: false,
});
assert.equal(mm.model, 'image-01');
assert.equal(mm.promptOptimizer, false);
assert.equal(mm.count, 3);
assert.equal(mm.seed, 42);
assert.equal(mm.width, 1024);
assert.equal(mm.referencePaths.length, 1);

assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x'.repeat(1501) }),
  /at most 1500 characters/,
);
assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x', count: 10 }),
  /at most 9 images/,
);
assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x', width: 1025, height: 1024 }),
  /divisible by 8/,
);
assert.throws(
  () => validateImageRequest({ model: 'gpt-image-2', prompt: 'x', promptOptimizer: true }),
  /promptOptimizer is supported by image-01/,
);
assert.throws(
  () => validateImageRequest({ model: 'nano-banana', prompt: 'x', referencePaths: Array.from({ length: 15 }, (_, i) => `/media/uploads/${i}.jpg`) }),
  /too many reference images/,
);

const gpt = validateImageRequest({
  model: 'gpt-image-2',
  prompt: 'product shot',
  referencePaths: ['/media/uploads/source.png'],
  maskPath: '/media/uploads/mask.png',
  background: 'transparent',
  moderation: 'low',
  inputFidelity: 'high',
  outputFormat: 'webp',
  outputCompression: 82,
});
assert.equal(gpt.inputFidelity, 'high');
assert.equal(gpt.outputCompression, 82);
assert.throws(
  () => validateImageRequest({ model: 'gpt-image-2', prompt: 'x', outputCompression: 80 }),
  /requires outputFormat jpeg or webp/,
);
assert.throws(
  () => validateImageRequest({ model: 'nano-banana', prompt: 'x', quality: 'high' }),
  /GPT Image options are not supported/,
);

const waveSpeed = validateImageRequest({ model: 'wavespeed', prompt: 'a mountain at sunset', aspectRatio: '1:1' });
assert.equal(waveSpeed.model, 'wavespeed');
assert.equal(waveSpeed.aspectRatio, '1:1');
assert.throws(
  () => validateImageRequest({ model: 'wavespeed', prompt: 'x', quality: 'high' }),
  /GPT Image options are not supported/,
);
assert.throws(
  () => validateImageRequest({ model: 'wavespeed', prompt: 'x', referencePaths: ['/media/uploads/a.jpg'] }),
  /too many reference images/,
);

const byteplus = validateImageRequest({ model: 'byteplus', prompt: 'a neon city street', aspectRatio: '9:16' });
assert.equal(byteplus.model, 'byteplus');
assert.equal(byteplus.aspectRatio, '9:16');
assert.throws(
  () => validateImageRequest({ model: 'byteplus', prompt: 'x', referencePaths: ['/media/uploads/a.jpg'] }),
  /too many reference images/,
);


const grok = validateImageRequest({ model: 'grok-imagine', prompt: 'a corgi surfing', aspectRatio: '9:16', imageSize: '2K', count: 4 });
assert.equal(grok.model, 'grok-imagine');
assert.equal(grok.aspectRatio, '9:16');
assert.equal(grok.count, 4);
assert.throws(
  () => validateImageRequest({ model: 'grok-imagine', prompt: 'x', imageSize: '4K' }),
  /imageSize must be 1K or 2K/,
);
assert.throws(
  () => validateImageRequest({ model: 'grok-imagine', prompt: 'x', aspectRatio: '21:9' }),
  /does not support aspect ratio/,
);
assert.throws(
  () => validateImageRequest({ model: 'grok-imagine', prompt: 'x', count: 5 }),
  /at most 4 images/,
);
assert.throws(
  () => validateImageRequest({ model: 'grok-imagine', prompt: 'x', referencePaths: ['/media/uploads/a.jpg'] }),
  /too many reference images/,
);
console.log('image.check: ok (provider-specific official parameters)');
