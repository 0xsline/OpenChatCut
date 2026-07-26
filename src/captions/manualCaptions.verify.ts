import assert from 'node:assert/strict';
import { captionPages, captionsToSrt } from './exportCaptions';
import { buildLaneGroups } from './lanes';
import {
  appendDroppedManualCaption, appendManualCue, appendManualCueToFirstLane, appendManualLane, isManualCaptionEntry,
  newManualCaptions, placeManualCueTiming, removeManualCue, resizeManualCue, updateManualCue,
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

captions = { ...captions, ...appendManualCue(captions, laneId, '下一句', 3_000, 4_000) };
captions = { ...captions, ...resizeManualCue(captions, laneId, 0, 'start', -500) };
assert.equal(captions.sourceEntries![0]!.words![0]!.start, 700, 'left edge extends earlier');
captions = { ...captions, ...resizeManualCue(captions, laneId, 0, 'end', 2_000) };
assert.equal(captions.sourceEntries![0]!.words![0]!.end, 3_000, 'right edge stops at the next cue');

const secondLane = appendManualLane(captions, []);
captions = { ...captions, ...secondLane };
assert.equal(captions.sourceEntries!.filter(isManualCaptionEntry).length, 2, 'multiple manual lanes persist');

let destination = newManualCaptions();
destination = { ...destination, ...appendManualCueToFirstLane(destination, [], '跨轨字幕', 1_000, 3_000) };
destination = { ...destination, ...appendManualCueToFirstLane(destination, [], '允许重叠', 2_000, 4_000) };
assert.deepEqual(destination.sourceEntries![0]!.words?.map((word) => word.text), ['跨轨字幕', '允许重叠']);

const dropped = appendDroppedManualCaption(captions, [], 'tiktok', '拖入字幕', 5_000, {
  anchor: 'middle-center', offsetXRatio: 0.2, offsetYRatio: -0.15,
});
assert.ok(dropped);
captions = { ...captions, ...dropped.patch };
const droppedEntry = captions.sourceEntries!.find((entry) => entry.id === dropped.laneId)!;
assert.equal(droppedEntry.words?.[0]?.text, '拖入字幕');
assert.equal(droppedEntry.offsetXRatio, 0.2);
assert.equal(droppedEntry.style?.highlightBackground, '#FF2E63');

captions = { ...captions, ...removeManualCue(captions, laneId, 0) };
captions = { ...captions, ...removeManualCue(captions, laneId, 0) };
assert.equal(captions.sourceEntries!.find((entry) => entry.id === laneId)?.words?.length, 0);

// —— placeManualCueTiming:拖动放置的无重叠钳制(同轨/跨轨拖拽共用) ——
const occupied = [{ text: 'a', start: 0, end: 1_000 }, { text: 'c', start: 1_200, end: 2_000 }];
assert.equal(placeManualCueTiming(occupied, 1_050, 1_000), null, '1000ms cue 拖进 200ms 间隙 → 拒绝(调用方回弹)');
assert.deepEqual(placeManualCueTiming(occupied, 1_050, 150), { start: 1_050, end: 1_200 }, '塞得下按请求位放,右侧被邻居顶住');
assert.deepEqual(placeManualCueTiming(occupied, 950, 200), { start: 1_000, end: 1_200 }, '压到前邻居尾部 → 贴边恰好填满间隙');
assert.deepEqual(placeManualCueTiming(occupied, 5_000, 700), { start: 5_000, end: 5_700 }, '可越过邻居跳到远处开阔区');
assert.deepEqual(placeManualCueTiming([], -500, 800), { start: 0, end: 800 }, '空 lane:负落点钳到 0,时长保持');

console.log('manualCaptions.check: ok');
