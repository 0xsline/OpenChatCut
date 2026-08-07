import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  timelineGestureHasDragged,
  timelinePointerShouldSeek,
  timelineSeekFrameAtClientX,
} from './timelineSeek';

const geometry = {
  contentLeft: 100,
  headerWidth: 112,
  pixelsPerFrame: 2,
  totalFrames: 120,
};

assert.equal(timelineSeekFrameAtClientX(212, geometry), 0);
assert.equal(timelineSeekFrameAtClientX(312, geometry), 50);
assert.equal(timelineSeekFrameAtClientX(451, geometry), 119);
assert.equal(timelineSeekFrameAtClientX(452, geometry), null);
assert.equal(timelineSeekFrameAtClientX(211, geometry), null);
assert.equal(timelineSeekFrameAtClientX(312, { ...geometry, totalFrames: 0 }), null);

assert.equal(timelinePointerShouldSeek(0, false, false), true);
assert.equal(timelinePointerShouldSeek(2, false, false), false);
assert.equal(timelinePointerShouldSeek(0, true, false), false);
assert.equal(timelinePointerShouldSeek(0, false, true), false);

assert.equal(timelineGestureHasDragged(10, 10, 13, 13), false);
assert.equal(timelineGestureHasDragged(10, 10, 14, 10), true);
assert.equal(timelineGestureHasDragged(10, 10, 10, 14), true);

const timelineSource = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
assert.match(timelineSource, /onPointerDownCapture=\{startSeekGesture\}/);
const controllerSource = readFileSync(new URL('./useTimelineController.ts', import.meta.url), 'utf8');
assert.match(controllerSource, /onHoverPreviewFrameChange\?\.\(frame\)/);
assert.match(timelineSource, /className="cc-timeline-hover-guide"/);

const previewSource = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(previewSource, /hoverPreviewFrame !== null/);
assert.match(previewSource, /<Thumbnail[\s\S]*?frameToDisplay=\{hoverPreviewFrame\}/);

console.log('timelineSeek.verify: frame mapping and drag-safe seeking passed');
