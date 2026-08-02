import assert from 'node:assert/strict';
import { motionGraphicPreviewFrame } from './mgPreview';

assert.equal(motionGraphicPreviewFrame(60), 30);
assert.equal(motionGraphicPreviewFrame(1), 0);
assert.equal(motionGraphicPreviewFrame(0), 0);

console.log('mgPreview.verify: stable representative frames pass');
