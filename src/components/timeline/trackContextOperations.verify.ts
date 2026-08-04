import assert from 'node:assert/strict';
import type { TimelineState } from '../../editor/types';
import { closeCaptionTrackGaps, trackClearPlan, trackContextMenuLabels } from './trackContextOperations';

assert.deepEqual(trackContextMenuLabels('video').slice(0, 2), ['插入素材', '闭合缝隙']);
assert.ok(trackContextMenuLabels('audio').includes('自动闪避'));
assert.ok(trackContextMenuLabels('caption').includes('字幕样式'));
assert.ok(!trackContextMenuLabels('caption').includes('静音轨道'));

const state: TimelineState = {
  fps: 30, width: 1080, height: 1920, items: [], selectedId: null,
  trackOrder: ['C1'], tracks: { C1: { kind: 'caption', captions: {
    enabled: true, template: 'plain', pacing: 'phrase', sourceEntries: [{
      id: 'lane-1', itemId: 'manual:lane-1', words: [
        { text: '一', start: 1_000, end: 2_000 },
        { text: '二', start: 4_000, end: 5_500 },
        { text: '三', start: 5_200, end: 6_000 },
      ],
    }],
  } } },
};
const captions = state.tracks!.C1!.captions!;
const tightened = closeCaptionTrackGaps(captions);
assert.equal(tightened.changed, true);
assert.deepEqual(tightened.captions.sourceEntries?.[0]?.words?.map(({ start, end }) => [start, end]), [
  [1_000, 2_000], [2_000, 3_500], [5_200, 6_000],
]);
assert.equal(trackClearPlan(state, 'C1').hasContents, true);
assert.deepEqual(trackClearPlan(state, 'C1').actions, [{ type: 'setCaptions', captions: null, track: 'C1' }]);

console.log('track context operations verify passed');
