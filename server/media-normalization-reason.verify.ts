import assert from 'node:assert/strict';
import { normalizeReason, type ProbeMeta } from './media-normalization.ts';

const largeVfr: ProbeMeta = {
  width: 1920,
  height: 1080,
  duration: 60,
  videoCodec: 'h264',
  audioCodec: 'aac',
  hasAudio: true,
  sourceBitrate: 20_000_000,
  size: 2 * 1024 ** 3,
  avgFrameRate: 29.97,
  nominalFrameRate: 30,
  variableFrameRate: true,
};

assert.match(
  normalizeReason(largeVfr, 10_000_000, false, false) ?? '',
  /variable frame rate/,
  'large VFR sources must retain the CFR compatibility path',
);
assert.match(normalizeReason(largeVfr, 10_000_000, true, false) ?? '', /variable frame rate/);

console.log('media normalization reason verification passed');
