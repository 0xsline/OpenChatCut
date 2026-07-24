import assert from 'node:assert/strict';
import { captionPages, captionsToSrt } from './exportCaptions';
import { buildLaneGroups } from './lanes';
import {
  appendDroppedManualCaption, appendManualCue, appendManualLane, isManualCaptionEntry,
  newManualCaptions, removeManualCue, resizeManualCue, updateManualCue,
} from './manualCaptions';

let captions = newManualCaptions();
const laneId = captions.sourceEntries![0]!.id;
assert.equal(captions.sourceEntries!.filter(isManualCaptionEntry).length, 1);

const added = appendManualCue(captions, laneId, 'first sentence', 1_000, 2_000);
assert.ok(added?.sourceEntries);
captions = { ...captions, ...added };
assert.equal(buildLaneGroups(captions, [], 30, 1_500, 6)?.[0]?.lanes[0]?.page.words[0]?.text, 'first sentence');
assert.deepEqual(buildLaneGroups(captions, [], 30, 2_500, 6), [], 'manual cue ends exactly at endMs');

const updated = updateManualCue(captions, laneId, 0, 'modified subtitles', 1_200, 2_400);
assert.ok(updated?.sourceEntries);
captions = { ...captions, ...updated };
assert.equal(captionPages(captions, [], 30)[0]?.words[0]?.text, 'modified subtitles');
assert.match(captionsToSrt(captions, [], 30), /00:00:01,200 --> 00:00:02,400\nmodified subtitles/);

captions = { ...captions, ...appendManualCue(captions, laneId, 'next sentence', 3_000, 4_000) };
captions = { ...captions, ...resizeManualCue(captions, laneId, 0, 'start', -500) };
assert.equal(captions.sourceEntries![0]!.words![0]!.start, 700, 'left edge extends earlier');
captions = { ...captions, ...resizeManualCue(captions, laneId, 0, 'end', 2_000) };
assert.equal(captions.sourceEntries![0]!.words![0]!.end, 3_000, 'right edge stops at the next cue');

const secondLane = appendManualLane(captions, []);
captions = { ...captions, ...secondLane };
assert.equal(captions.sourceEntries!.filter(isManualCaptionEntry).length, 2, 'multiple manual lanes persist');

const dropped = appendDroppedManualCaption(captions, [], 'tiktok', 'Drag subtitles', 5_000, {
  anchor: 'middle-center', offsetXRatio: 0.2, offsetYRatio: -0.15,
});
assert.ok(dropped);
captions = { ...captions, ...dropped.patch };
const droppedEntry = captions.sourceEntries!.find((entry) => entry.id === dropped.laneId)!;
assert.equal(droppedEntry.words?.[0]?.text, 'Drag subtitles');
assert.equal(droppedEntry.offsetXRatio, 0.2);
assert.equal(droppedEntry.style?.highlightBackground, '#FF2E63');

captions = { ...captions, ...removeManualCue(captions, laneId, 0) };
captions = { ...captions, ...removeManualCue(captions, laneId, 0) };
assert.equal(captions.sourceEntries!.find((entry) => entry.id === laneId)?.words?.length, 0);

console.log('manualCaptions.check: ok');
