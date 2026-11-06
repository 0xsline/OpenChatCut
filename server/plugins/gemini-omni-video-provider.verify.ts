import assert from 'node:assert/strict';
import {
  extractOmniVideo,
  omniAspectRatio,
  omniPromptWithDuration,
  omniResolution,
  omniTask,
} from './gemini-omni-video-helpers.ts';
import { validateVideoRequest } from './video-validation.ts';

assert.equal(omniAspectRatio('9:16'), '9:16');
assert.equal(omniAspectRatio('16:9'), '16:9');
assert.equal(omniAspectRatio('1:1'), '16:9');

assert.equal(omniResolution(undefined), '720p');
assert.equal(omniResolution('1080p'), '1080p');
assert.equal(omniResolution('480p'), '720p');

assert.equal(omniTask({ firstFramePath: undefined, lastFramePath: undefined, refImagePaths: [] }), undefined);
assert.equal(omniTask({ firstFramePath: '/media/uploads/a.jpg', lastFramePath: undefined, refImagePaths: [] }), 'image_to_video');
assert.equal(omniTask({ firstFramePath: undefined, lastFramePath: undefined, refImagePaths: ['/media/uploads/a.jpg'] }), 'reference_to_video');
assert.equal(
  omniTask({ firstFramePath: '/media/uploads/a.jpg', lastFramePath: '/media/uploads/b.jpg', refImagePaths: [] }),
  undefined,
);

assert.equal(
  omniPromptWithDuration('A cat jumps', 8, true),
  'A cat jumps\n\nTarget length: about 8 seconds.',
);
assert.equal(omniPromptWithDuration('A cat jumps for 8 seconds', 8, true), 'A cat jumps for 8 seconds');
assert.equal(omniPromptWithDuration('A cat jumps', 5, false), 'A cat jumps');

const fromConvenience = extractOmniVideo({
  output_video: { data: 'AAAA', mime_type: 'video/mp4' },
});
assert.equal(fromConvenience.data, 'AAAA');

const fromSteps = extractOmniVideo({
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
    {
      type: 'model_output',
      content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://example.test/v.mp4' }],
    },
  ],
});
assert.equal(fromSteps.uri, 'https://example.test/v.mp4');
assert.equal(extractOmniVideo({}).data, undefined);

const t2v = validateVideoRequest({
  model: 'gemini-omni', prompt: 'marble track', durationSeconds: 6, ratio: '16:9',
});
assert.equal(t2v.model, 'gemini-omni');
assert.equal(t2v.ratio, '16:9');

const i2v = validateVideoRequest({
  model: 'gemini-omni',
  prompt: 'animate still',
  firstFramePath: '/media/uploads/a.jpg',
  resolution: '1080p',
});
assert.equal(i2v.firstFramePath, '/media/uploads/a.jpg');
assert.equal(i2v.resolution, '1080p');

assert.throws(
  () => validateVideoRequest({ model: 'gemini-omni', prompt: 'x', ratio: '1:1' }),
  /16:9 or 9:16/,
);
assert.throws(
  () => validateVideoRequest({
    model: 'gemini-omni',
    prompt: 'x',
    firstFramePath: '/media/uploads/a.jpg',
    refImagePaths: ['/media/uploads/b.jpg'],
  }),
  /cannot be combined with refImages/,
);
assert.throws(
  () => validateVideoRequest({
    model: 'gemini-omni',
    prompt: 'x',
    refVideoPaths: ['/media/uploads/v.mp4'],
  }),
  /refVideos\/refAudios/,
);

console.log('gemini-omni-video-provider.verify: ok');
