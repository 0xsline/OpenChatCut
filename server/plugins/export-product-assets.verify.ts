import assert from 'node:assert/strict';
import { resolveProductAsset } from '../product-assets.ts';
import { validateServerExportMedia } from './export-media-plan.ts';

const source = '/audio/track-2.mp3';
const itemId = 'product-audio';

assert.ok(resolveProductAsset(source), 'the bundled product audio fixture must exist');

const plan = await validateServerExportMedia({
  items: [{ id: itemId, kind: 'audio', src: `${source}?cache=1` }],
});

assert.equal(plan.issues.length, 0, 'bundled product media must pass server export preflight');
console.log('server product asset export preflight verification passed');
