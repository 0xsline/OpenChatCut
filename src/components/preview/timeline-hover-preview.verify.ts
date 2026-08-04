import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const preview = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
const timeline = readFileSync(new URL('../timeline/Timeline.tsx', import.meta.url), 'utf8');

assert.match(preview, /hoverPreviewFrame\?: number \| null/, 'hover preview remains separate from the main playhead');
assert.match(preview, /className="cc-preview-hover-frame"/, 'the hovered frame renders inside the preview canvas');
assert.match(preview, /frameToDisplay=\{hoverPreviewFrame\}/, 'the thumbnail renders the exact hovered frame');
assert.match(
  timeline,
  /if \(playing \|\| drag \|\| marquee \|\| pickDrag\) clearHoverPreview\(\);[\s\S]*?\}, \[playing, drag, marquee, pickDrag\]\);/,
  'playback and gestures immediately clear an existing hover renderer',
);

console.log('timeline-hover-preview.verify: immediate playback cleanup OK');
