import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const preview = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../timeline/useTimelineController.ts', import.meta.url), 'utf8');

assert.match(preview, /acknowledgeRemotionLicense/, 'the preview Player acknowledges the Remotion license');
assert.match(preview, /hoverPreviewFrame\?: number \| null/, 'hover preview remains separate from the main playhead');
assert.match(preview, /className="cc-preview-hover-frame"/, 'the hovered frame renders inside the preview canvas');
assert.match(preview, /frameToDisplay=\{hoverPreviewFrame\}/, 'the thumbnail renders the exact hovered frame');
// The playback/gesture cleanup effect moved from Timeline.tsx into
// useTimelineController.ts when pointer handling was consolidated.
assert.match(
  controller,
  /if \(playing \|\| drag \|\| marquee \|\| pickDrag\) clearHoverPreviewRef\.current\(\);[\s\S]*?\}, \[playing, drag, marquee, pickDrag\]\);/,
  'playback and gestures immediately clear an existing hover renderer',
);

console.log('timeline-hover-preview.verify: immediate playback cleanup OK');
