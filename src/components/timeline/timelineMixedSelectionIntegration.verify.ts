import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const editor = source('../../editor/useEditorController.tsx');
const timeline = source('./Timeline.tsx');
const controller = source('./useTimelineController.ts');
const pointer = source('./useTimelinePointer.ts');
const trackLane = source('./TrackLane.tsx');

assert.match(editor, /selectedCaptions:\s*captionSelections/);
assert.match(editor, /onMarqueeCaptionSelect:\s*selectMarqueeCaptions/);
assert.match(editor, /onDropExternalFiles:\s*dropExternalFilesToTimeline/);
assert.match(editor, /selectAllTimelineContent/);

assert.match(controller, /createCaptionTimelineClipboard/);
assert.match(controller, /createCaptionTrackFromClipboard/);
assert.match(timeline, /onDropExternalFiles=\{onDropExternalFiles\}/);

assert.match(pointer, /moveTimelineSelectionByDelta/);
assert.match(pointer, /selectionInMarquee/);
assert.match(trackLane, /selectionMovePreviewDeltaForItem/);

console.log('timelineMixedSelectionIntegration.verify: parent wiring OK');
