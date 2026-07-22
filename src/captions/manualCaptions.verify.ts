import assert from 'node:assert/strict';
import { captionPages, captionsToSrt } from './exportCaptions';
import { buildLaneGroups } from './lanes';
import {
  appendManualCue, appendManualLane, isManualCaptionEntry,
  newManualCaptions, removeManualCue, updateManualCue,
} from './manualCaptions';

let captions = newManualCaptions();
const laneId = captions.sourceEntries![0]!.id;
assert.equal(captions.sourceEntries!.filter(isManualCaptionEntry).length, 1);

const added = appendManualCue(captions, laneId, '第一句', 1_000, 2_000);
assert.ok(added?.sourceEntries);
captions = { ...captions, ...added };
assert.equal(buildLaneGroups(captions, [], 30, 1_500, 6)?.[0]?.lanes[0]?.page.words[0]?.text, '第一句');
assert.deepEqual(buildLaneGroups(captions, [], 30, 2_500, 6), [], 'manual cue ends exactly at endMs');

const updated = updateManualCue(captions, laneId, 0, '改过的字幕', 1_200, 2_400);
assert.ok(updated?.sourceEntries);
captions = { ...captions, ...updated };
assert.equal(captionPages(captions, [], 30)[0]?.words[0]?.text, '改过的字幕');
assert.match(captionsToSrt(captions, [], 30), /00:00:01,200 --> 00:00:02,400\n改过的字幕/);

const secondLane = appendManualLane(captions, []);
captions = { ...captions, ...secondLane };
assert.equal(captions.sourceEntries!.filter(isManualCaptionEntry).length, 2, 'multiple manual lanes persist');

captions = { ...captions, ...removeManualCue(captions, laneId, 0) };
assert.equal(captions.sourceEntries!.find((entry) => entry.id === laneId)?.words?.length, 0);

console.log('manualCaptions.check: ok');
