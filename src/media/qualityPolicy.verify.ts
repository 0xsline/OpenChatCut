import assert from 'node:assert/strict';
import {
  defaultBitrateModeForQuality,
  exportResolutionForCanvas,
  qualityPolicy,
  shouldAutoRequestPreviewProxy,
  shouldPreferMasterPreview,
} from './qualityPolicy';

assert.equal(qualityPolicy('master').allowOptimizeOnIngest, false);
assert.equal(qualityPolicy('master').previewPreferMaster, true);
assert.equal(qualityPolicy('master').defaultBitrateMode, 'high');
assert.equal(qualityPolicy('balanced').previewPreferMaster, false);
assert.equal(qualityPolicy('balanced').defaultBitrateMode, 'auto');

assert.equal(exportResolutionForCanvas({ width: 3840, height: 2160 }, 'master'), '4k');
assert.equal(exportResolutionForCanvas({ width: 1920, height: 1080 }, 'master'), '1080p');
assert.equal(exportResolutionForCanvas({ width: 1920, height: 1080 }, 'balanced'), '1080p');
assert.equal(exportResolutionForCanvas({ width: 1280, height: 720 }, 'balanced'), '720p');
assert.equal(exportResolutionForCanvas({ width: 1280, height: 720 }, 'master'), '720p');
// Master never defaults an HD canvas down to 480p
assert.equal(exportResolutionForCanvas({ width: 854, height: 480 }, 'master'), '480p');
assert.equal(exportResolutionForCanvas({ width: 854, height: 480 }, 'balanced'), '480p');

assert.equal(defaultBitrateModeForQuality('master'), 'high');
assert.equal(defaultBitrateModeForQuality('balanced'), 'auto');
assert.equal(shouldAutoRequestPreviewProxy('master', 'auto'), false);
assert.equal(shouldAutoRequestPreviewProxy('balanced', 'auto'), true);
assert.equal(shouldAutoRequestPreviewProxy('master', 'proxy'), true);
assert.equal(shouldAutoRequestPreviewProxy('balanced', 'original'), false);
assert.equal(shouldAutoRequestPreviewProxy('balanced'), false);
assert.equal(shouldPreferMasterPreview('master', 'auto'), true);
assert.equal(shouldPreferMasterPreview('balanced', 'auto'), false);
assert.equal(shouldPreferMasterPreview('balanced', 'original'), true);
assert.equal(shouldPreferMasterPreview('master', 'proxy'), false);

console.log('qualityPolicy.verify: ok');
