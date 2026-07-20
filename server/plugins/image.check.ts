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
  promptOptimizer: false,
});
assert.equal(mm.model, 'image-01');
assert.equal(mm.promptOptimizer, false);
assert.equal(mm.count, 3);

assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x'.repeat(1501) }),
  /at most 1500 characters/,
);
assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x', count: 10 }),
  /at most 9 images/,
);
assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x', referencePaths: ['/media/uploads/a.jpg'] }),
  /does not support reference images/,
);
assert.throws(
  () => validateImageRequest({ model: 'gpt-image-2', prompt: 'x', promptOptimizer: true }),
  /promptOptimizer is supported by image-01/,
);
assert.throws(
  () => validateImageRequest({ model: 'nano-banana', prompt: 'x', referencePaths: Array.from({ length: 15 }, (_, i) => `/media/uploads/${i}.jpg`) }),
  /too many reference images/,
);

console.log('image.check: ok (minimax optimizer + limits)');
