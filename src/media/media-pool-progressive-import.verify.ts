import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [pool, editor] = await Promise.all([
  readFile(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../Editor.tsx', import.meta.url), 'utf8'),
]);

assert.match(pool, /onPlaceholder\?: \(asset: MediaAsset\) => void/, 'imports expose their placeholder lifecycle');
assert.match(pool, /const completions: Promise<void>\[\] = \[\]/, 'ready work is tracked independently from placeholder placement');
assert.match(pool, /onPlaceholder: markStarted/, 'a pool placeholder immediately enters the current folder');
assert.match(pool, /await started;[\s\S]*?await Promise\.all\(completions\)/, 'the next file starts after a placeholder while final readiness is still awaited');
assert.match(editor, /lifecycle\?\.onPlaceholder\?\.\(asset\)/, 'the editor forwards placeholder readiness');
assert.match(editor, /lifecycle\?\.onAssetUpdated\?\.\(ready\)/, 'the editor forwards authoritative asset readiness');
assert.match(editor, /lifecycle\?\.onFailure\?\.\(placeholder, err\)/, 'failed placeholders are reported and removed');

console.log('media-pool-progressive-import.verify: lifecycle wiring OK');
