import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ClipFx.tsx', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /import \{[^}]*\bVideo\b[^}]*\} from 'remotion'/,
  'effect preview must not reintroduce the HTML video decoder path',
);
assert.match(
  source,
  /<MediaVideo[\s\S]*onVideoFrame=\{onVideoFrame\}/,
  'effect preview must receive decoded frames from @remotion/media',
);
assert.doesNotMatch(
  source,
  /setRenderedKey\(renderKey\)/,
  'effect playback must not schedule a second React render for every decoded frame',
);

console.log('clipFxPreview.verify: GL preview uses the shared @remotion/media decoder path');
