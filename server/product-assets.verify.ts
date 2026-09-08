// Product assets must resolve from every registered root, not only the checkout's assets/.
// The packaged desktop app runs with cwd in userData, where assets/ does not exist, so
// `/voice-samples/x.mp3` used to resolve to nothing for probe, sandbox and export even
// though the file shipped in resources/dist.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productAssetRoots, registerProductAssetRoot, resolveProductAsset, PRODUCT_ASSETS_DIR } from './product-assets.ts';

const root = mkdtempSync(join(tmpdir(), 'product-assets-'));
try {
  mkdirSync(join(root, 'voice-samples'), { recursive: true });
  mkdirSync(join(root, 'media', 'uploads'), { recursive: true });
  writeFileSync(join(root, 'voice-samples', 'hope.mp3'), 'x');
  writeFileSync(join(root, 'media', 'uploads', 'user.mp4'), 'x');
  writeFileSync(join(root, 'index.html'), '<html>');

  assert.equal(resolveProductAsset('/voice-samples/hope.mp3'), null, 'nothing resolves before the root is registered');
  registerProductAssetRoot(root);
  registerProductAssetRoot(root);
  assert.deepEqual(productAssetRoots(), [PRODUCT_ASSETS_DIR, root], 'registering twice keeps one entry');

  assert.equal(resolveProductAsset('/voice-samples/hope.mp3'), join(root, 'voice-samples', 'hope.mp3'));
  assert.equal(resolveProductAsset('/voice-samples/hope.mp3?v=2'), join(root, 'voice-samples', 'hope.mp3'), 'query strings are ignored');
  assert.equal(resolveProductAsset('/voice-samples/%68ope.mp3'), join(root, 'voice-samples', 'hope.mp3'), 'percent-encoding is decoded');
  assert.equal(resolveProductAsset('/media/uploads/user.mp4'), null, 'user uploads are never product assets');
  assert.equal(resolveProductAsset('/voice-samples/../../etc/passwd'), null, 'traversal is rejected');
  assert.equal(resolveProductAsset('/'), null);
  assert.equal(resolveProductAsset('/voice-samples'), null, 'directories are not files');
  assert.equal(resolveProductAsset('/%E0%A4%A'), null, 'malformed encoding does not throw');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('product-assets checks passed (registered roots, traversal, uploads excluded)');
