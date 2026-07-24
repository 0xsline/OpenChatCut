import assert from 'node:assert/strict';
import { appendManualCue, newManualCaptions } from './manualCaptions';
import {
  captionPreviewLayoutPatch,
  captionPreviewStylePatch,
  captionPreviewTextPatch,
  findCaptionPreviewTarget,
} from './captionPreviewTarget';

let captions = newManualCaptions();
const laneId = captions.sourceEntries![0]!.id;
captions = { ...captions, ...appendManualCue(captions, laneId, 'Editable on screen', 1_000, 2_000) };

const target = findCaptionPreviewTarget(captions, [], 30, 1_500);
assert.equal(target?.kind, 'manual', 'manual multi-lane captions expose a preview edit target');
assert.equal(target?.cue.text, 'Editable on screen');

const textPatch = captionPreviewTextPatch(captions, target!, 'Preview has been changed');
assert.equal(textPatch?.sourceEntries?.[0]?.words?.[0]?.text, 'Preview has been changed');

const stylePatch = captionPreviewStylePatch(captions, target!, { color: '#ff0000' });
assert.equal(stylePatch.sourceEntries?.[0]?.style?.color, '#ff0000');

const layoutPatch = captionPreviewLayoutPatch(captions, target!, {
  anchor: 'bottom-center', offsetXRatio: 0.1, offsetYRatio: 0.2,
});
assert.equal(layoutPatch.sourceEntries?.[0]?.offsetXRatio, 0.1);
assert.equal(layoutPatch.sourceEntries?.[0]?.offsetYRatio, 0.2);

const deletePatch = captionPreviewTextPatch(captions, target!, '');
assert.equal(deletePatch?.sourceEntries?.[0]?.words?.length, 0);

console.log('captionPreviewTarget.verify: ok');
