import assert from 'node:assert/strict';
import { anchoredTimelineScrollLeft, timelinePlayheadAnchorX } from './timelineZoom';
import {
  clearTimelineViewStates,
  loadTimelineViewState,
  saveTimelineViewState,
  type TimelineViewStorage,
} from './timelineViewState';

class MemoryStorage implements TimelineViewStorage {
  private readonly values: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.values[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.values[key] = value;
  }

  removeItem(key: string): void {
    delete this.values[key];
  }
}

const storage = new MemoryStorage();
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-a'), null, '无记录的 timeline 必须走 fit/default，而不是继承别的 timeline');

saveTimelineViewState(storage, 'project-a', 'timeline-a', {
  playhead: 120,
  zoom: 2.25,
  scrollLeft: 640,
  trackScale: 1.4,
});
saveTimelineViewState(storage, 'project-a', 'timeline-b', {
  playhead: 8,
  zoom: 0.75,
  scrollLeft: 24,
  trackScale: 0.8,
});

assert.deepEqual(loadTimelineViewState(storage, 'project-a', 'timeline-a'), {
  playhead: 120,
  zoom: 2.25,
  scrollLeft: 640,
  trackScale: 1.4,
});
assert.deepEqual(loadTimelineViewState(storage, 'project-a', 'timeline-b'), {
  playhead: 8,
  zoom: 0.75,
  scrollLeft: 24,
  trackScale: 0.8,
});

// Simulate A → B → A switching. A's exact view returns; B never leaks its frame or zoom into A.
const switchedToB = loadTimelineViewState(storage, 'project-a', 'timeline-b');
const switchedBackToA = loadTimelineViewState(storage, 'project-a', 'timeline-a');
assert.equal(switchedToB?.playhead, 8);
assert.equal(switchedBackToA?.playhead, 120);
assert.equal(switchedBackToA?.zoom, 2.25);
assert.equal(switchedBackToA?.scrollLeft, 640);
assert.equal(switchedBackToA?.trackScale, 1.4);

// Independent writers (playhead paint and zoom/scroll controller) merge without flattening the other fields.
saveTimelineViewState(storage, 'project-a', 'timeline-a', { playhead: 144 });
assert.deepEqual(loadTimelineViewState(storage, 'project-a', 'timeline-a'), {
  playhead: 144,
  zoom: 2.25,
  scrollLeft: 640,
  trackScale: 1.4,
});
assert.equal(loadTimelineViewState(storage, 'project-b', 'timeline-a'), null, 'project id is also part of the persistence boundary');

clearTimelineViewStates(storage, 'project-a');
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-a'), null);
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-b'), null);

const playhead = 200;
const header = 112;
const viewportWidth = 500;
const scrollLeft = 160;
const currentPixelsPerFrame = 2;
const anchor = timelinePlayheadAnchorX(playhead, scrollLeft, viewportWidth, header, currentPixelsPerFrame);
assert.equal(anchor, 352);
for (const pixelsPerFrame of [1.5, 4]) {
  const updatedScroll = anchoredTimelineScrollLeft(
    scrollLeft, anchor, header, currentPixelsPerFrame, pixelsPerFrame,
  );
  assert.equal(header + playhead * pixelsPerFrame - updatedScroll, anchor,
    'zooming keeps a visible playhead at its existing viewport coordinate');
}
const visibleCenter = header + (viewportWidth - header) / 2;
assert.equal(timelinePlayheadAnchorX(0, scrollLeft, viewportWidth, header, 2), visibleCenter);
assert.equal(timelinePlayheadAnchorX(800, scrollLeft, viewportWidth, header, 2), visibleCenter);
assert.equal(anchoredTimelineScrollLeft(0, header, header, 2, 4), 0,
  'zooming at frame zero stays on the first frame');

console.log('timelineViewState.verify: ok (timelineId 隔离/切换恢复/partial merge/项目清理)');
