import assert from 'node:assert/strict';
import type { TimelineItem, TimelineState, TransitionItem } from '../../editor/types';
import { clipMediaGeometry } from './clipMediaGeometry';
import {
  MAX_RULER_TICKS,
  buildTimelineIndexes,
  fmt,
  fmtRuler,
  intersectFrameRange,
  rulerTickWindow,
  timelineFrameWindow,
  timelinePinnedItemIds,
  visibleTimelineItems,
} from './timelineUtil';

const item = (id: string, startFrame: number, durationInFrames: number): TimelineItem => ({
  id,
  track: 'video-main',
  startFrame,
  durationInFrames,
  name: id,
  kind: 'video',
});

const transition: TransitionItem = {
  id: 'transition-a-c',
  type: 'cross-dissolve',
  durationInFrames: 12,
  outgoingItemId: 'a',
  incomingItemId: 'c',
  trackId: 'video-main',
};

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: 'a',
  selectedIds: ['a'],
  items: [item('a', 0, 20), item('b', 300, 20), item('c', 5_000, 20)],
  transitions: [transition],
};

{
  const window = timelineFrameWindow(1_000, 1_000, 2, 200);
  assert.deepEqual(window, { startFrame: 294, endFrame: 994 });
  assert.deepEqual(intersectFrameRange(280, 40, window), { startFrame: 294, endFrame: 320 });
  assert.equal(intersectFrameRange(0, 20, window), null);
}

{
  const indexes = buildTimelineIndexes(state);
  assert.equal(indexes.itemById.get('b')?.startFrame, 300);
  assert.equal(indexes.transitionByIncomingId.get('c')?.id, transition.id);
  const pinned = timelinePinnedItemIds(['a'], [], state.transitions ?? []);
  assert.deepEqual([...pinned], ['a', 'c'], 'transition counterpart stays pinned');
  const visible = visibleTimelineItems(
    indexes.itemWindowsByTrack.get('video-main'),
    { startFrame: 290, endFrame: 330 },
    pinned,
    indexes.itemById,
    indexes.itemOrderById,
    'video-main',
  );
  assert.deepEqual(visible.map((candidate) => candidate.id), ['a', 'b', 'c']);
}

{
  const ticks = rulerTickWindow({ startFrame: 0, endFrame: 10_000_000 }, 10_000_000, 30, 9);
  const minorCount = Number.isFinite(ticks.minorStride)
    ? Math.ceil(ticks.majorCount * 9 / ticks.minorStride)
    : 0;
  assert.ok(ticks.majorCount + minorCount <= MAX_RULER_TICKS);
}

{
  const geometry = clipMediaGeometry({
    clipStartFrame: 100,
    durationInFrames: 30 * 60 * 60 * 3,
    srcInFrame: 240,
    playbackRate: 1.5,
    px: 2,
    visibleWindow: { startFrame: 108_100, endFrame: 108_700 },
  });
  assert.ok(geometry);
  assert.equal(geometry.widthPx, 1_200, 'media work is bounded to visible pixels');
  assert.equal(geometry.durationInFrames, 600);
  assert.equal(geometry.srcInFrame, 162_240, 'visible offset maps through playback rate');
}

{
  // 138 / 30 * 100 is 459.99999999999994 in floating point; the label must still read 4.60 s.
  assert.equal(fmt(138, 30), '00:04.60');
  assert.equal(fmt(69, 30), '00:02.30');
  assert.equal(fmt(29, 25), '00:01.16');
  assert.equal(fmt(1799, 30), '00:59.96');
  assert.equal(fmt(1800, 30), '01:00.00');
  assert.equal(fmtRuler(138, 30), '04.60');
  assert.equal(fmtRuler(246, 30), '08.20');
  assert.equal(fmtRuler(1799, 30), '59.96');
  assert.equal(fmtRuler(1800, 30), '1:00');
  for (const fps of [24, 25, 30, 50, 60]) {
    for (let frame = 0; frame < fps * 120; frame++) {
      if ((frame * 100) % fps !== 0) continue;
      const exact = (frame * 100) / fps;
      const want = `${String(Math.floor(exact / 6000)).padStart(2, '0')}:${String(Math.floor(exact / 100) % 60).padStart(2, '0')}.${String(exact % 100).padStart(2, '0')}`;
      assert.equal(fmt(frame, fps), want, `frame ${frame} at ${fps} fps lands on a whole centisecond`);
    }
  }
}
