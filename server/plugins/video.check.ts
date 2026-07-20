import assert from 'node:assert/strict';
import { hailuoApiResolution, isMinimaxSubjectModel, klingPrompt, seedanceApiResolution, validateVideoRequest } from './video.ts';

assert.equal(hailuoApiResolution(undefined), '768P');
assert.equal(hailuoApiResolution('720p'), '768P');
assert.equal(hailuoApiResolution('1080p'), '1080P');

// T2V
const t2v = validateVideoRequest({ model: 'hailuo', prompt: 'a cat walks', durationSeconds: 6 });
assert.equal(t2v.durationSeconds, 6);
assert.equal(t2v.model, 'hailuo');

// I2V first frame
const i2v = validateVideoRequest({
  model: 'hailuo',
  prompt: 'the still comes alive',
  durationSeconds: 10,
  resolution: '720p',
  firstFramePath: '/media/uploads/a.jpg',
});
assert.equal(i2v.firstFramePath, '/media/uploads/a.jpg');
assert.equal(i2v.durationSeconds, 10);

// first + last frame
const fl = validateVideoRequest({
  model: 'hailuo',
  prompt: 'morph between frames',
  durationSeconds: 6,
  resolution: '1080p',
  firstFramePath: '/media/uploads/a.jpg',
  lastFramePath: '/media/uploads/b.jpg',
});
assert.equal(fl.lastFramePath, '/media/uploads/b.jpg');

// 1080p + 10s rejected (official matrix)
assert.throws(
  () => validateVideoRequest({ model: 'hailuo', prompt: 'x', durationSeconds: 10, resolution: '1080p' }),
  /1080p only supports durationSeconds 6/,
);

// last without first
assert.throws(
  () => validateVideoRequest({ model: 'hailuo', prompt: 'x', lastFramePath: '/media/uploads/b.jpg' }),
  /lastFrame requires firstFrame/,
);

// multi-ref still rejected
assert.throws(
  () => validateVideoRequest({
    model: 'hailuo',
    prompt: 'x',
    firstFramePath: '/media/uploads/a.jpg',
    refImagePaths: ['/media/uploads/c.jpg'],
  }),
  /does not support refImages/,
);

// kling multi-shot still blocked on hailuo path
assert.throws(
  () => validateVideoRequest({ model: 'hailuo', prompt: 'x', shotType: 'customize' }),
  /kling only/,
);

// seedance smoke + 1080p allowed
const seed = validateVideoRequest({ model: 'seedance2', prompt: 'wide shot', durationSeconds: 5 });
assert.equal(seed.model, 'seedance2');
const seedHd = validateVideoRequest({
  model: 'seedance2',
  prompt: 'wide shot',
  durationSeconds: 8,
  resolution: '1080p',
});
assert.equal(seedHd.resolution, '1080p');
const seedLd = validateVideoRequest({
  model: 'seedance2',
  prompt: 'draft',
  durationSeconds: 5,
  resolution: '480p',
});
assert.equal(seedLd.resolution, '480p');
assert.equal(seedanceApiResolution(undefined), '720p');
assert.equal(seedanceApiResolution('480p'), '480p');
const seed4k = validateVideoRequest({
  model: 'seedance2',
  prompt: 'hero final',
  durationSeconds: 6,
  resolution: '4k',
});
assert.equal(seed4k.resolution, '4k');
assert.equal(seedanceApiResolution('4k'), '4k');
assert.throws(
  () => validateVideoRequest({ model: 'hailuo', prompt: 'x', durationSeconds: 6, resolution: '480p' }),
  /hailuo resolution must be 720p or 1080p/,
);
assert.throws(
  () => validateVideoRequest({ model: 'hailuo', prompt: 'x', durationSeconds: 6, resolution: '4k' }),
  /hailuo resolution must be 720p or 1080p/,
);

// hailuo optimizer flags
const hailuoLit = validateVideoRequest({
  model: 'hailuo',
  prompt: 'literal [Push in]',
  durationSeconds: 6,
  promptOptimizer: false,
});
assert.equal(hailuoLit.promptOptimizer, false);
const hailuoFast = validateVideoRequest({
  model: 'hailuo',
  prompt: 'fast',
  durationSeconds: 6,
  fastPretreatment: true,
});
assert.equal(hailuoFast.fastPretreatment, true);
assert.throws(
  () => validateVideoRequest({
    model: 'hailuo',
    prompt: 'x',
    durationSeconds: 6,
    promptOptimizer: false,
    fastPretreatment: true,
  }),
  /fastPretreatment requires promptOptimizer/,
);
assert.throws(
  () => validateVideoRequest({ model: 'seedance2', prompt: 'x', durationSeconds: 5, promptOptimizer: true }),
  /promptOptimizer\/fastPretreatment are supported by hailuo only/,
);

// kling: one ref video + image limit 4
const klingVid = validateVideoRequest({
  model: 'kling',
  prompt: 'Follow @Video1 camera; @Image1 character walks.',
  durationSeconds: 5,
  firstFramePath: '/media/uploads/a.jpg',
  refImagePaths: ['/media/uploads/b.jpg'],
  refVideoPaths: ['/media/uploads/c.mp4'],
});
assert.equal(klingVid.refVideoPaths.length, 1);
assert.throws(
  () => validateVideoRequest({
    model: 'kling',
    prompt: 'x',
    durationSeconds: 5,
    refVideoPaths: ['/media/uploads/a.mp4', '/media/uploads/b.mp4'],
  }),
  /at most 1 reference video/,
);
assert.throws(
  () => validateVideoRequest({
    model: 'kling',
    prompt: 'x',
    durationSeconds: 5,
    firstFramePath: '/media/uploads/1.jpg',
    refImagePaths: ['/media/uploads/2.jpg', '/media/uploads/3.jpg', '/media/uploads/4.jpg', '/media/uploads/5.jpg'],
    refVideoPaths: ['/media/uploads/c.mp4'],
  }),
  /at most 4 images/,
);

// kling base edit mode
const klingBase = validateVideoRequest({
  model: 'kling',
  prompt: 'Replace the scarf in @Video1 with red; keep camera.',
  durationSeconds: 5,
  refVideoPaths: ['/media/uploads/c.mp4'],
  refVideoMode: 'base',
});
assert.equal(klingBase.refVideoMode, 'base');
assert.throws(
  () => validateVideoRequest({ model: 'kling', prompt: 'x', durationSeconds: 5, refVideoMode: 'base' }),
  /refVideoMode requires refVideos/,
);
assert.throws(
  () => validateVideoRequest({ model: 'seedance2', prompt: 'x', durationSeconds: 5, refVideoMode: 'feature' }),
  /refVideoMode is supported by kling only/,
);

assert.equal(klingPrompt('@Image1 and @Video1 then @图片2'), '<<<image_1>>> and <<<video_1>>> then <<<image_2>>>');
assert.equal(isMinimaxSubjectModel('S2V-01'), true);
assert.equal(isMinimaxSubjectModel('MiniMax-Hailuo-02'), false);

console.log('video.check: ok (seedance 480p + kling base/feature + hailuo)');
