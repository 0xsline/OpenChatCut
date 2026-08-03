import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [pool, library, editor] = await Promise.all([
  readFile(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../library/LibraryPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../Editor.tsx', import.meta.url), 'utf8'),
]);

assert.match(pool, /onAddAssetsToTimeline\?/, 'the media pool exposes one batch timeline callback');
assert.match(pool, /onAddAssetsToTimeline\(menuAssets\)/, 'the context menu forwards the complete multi-selection');
assert.match(pool, /onAddAssetsToTimeline\(selectedAssets\)/, 'the selection toolbar forwards the complete multi-selection');
assert.match(library, /onAddMediaAssetsToTimeline/, 'the library forwards the batch callback');
assert.match(editor, /const addMediaAssetsToTimeline[\s\S]*?select: commands\.selectItems/, 'the editor selects every newly placed clip together');

console.log('media-pool-batch-timeline.verify: batch placement wiring OK');
