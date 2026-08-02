import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const editor = source('../../Editor.tsx');
const timeline = source('./Timeline.tsx');
const pointer = source('./useTimelinePointer.ts');
const trackLane = source('./TrackLane.tsx');

assert.match(editor, /selectedCaptions=\{captionSelections\}/);
assert.match(editor, /onMarqueeCaptionSelect=\{selectMarqueeCaptions\}/);
assert.match(editor, /onDropExternalFiles=\{dropExternalFilesToTimeline\}/);
assert.match(editor, /selectAll:\s*selectAllTimelineContent/);

assert.match(timeline, /createCaptionTimelineClipboard/);
assert.match(timeline, /createCaptionTrackFromClipboard/);
assert.match(timeline, /onDropExternalFiles=\{onDropExternalFiles\}/);

assert.match(pointer, /moveTimelineSelectionByDelta/);
assert.match(pointer, /selectionInMarquee/);
assert.match(trackLane, /selectionMovePreviewDeltaForItem/);

console.log('timelineMixedSelectionIntegration.verify: parent wiring OK');
