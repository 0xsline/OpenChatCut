import assert from 'node:assert/strict';
import { backgroundFillAppearance, backgroundFillFilter, isBackgroundFillActive, isBackgroundFillEligible } from './backgroundFill';
import { clipOpacityAt } from './clipFade';
import { isGlBaseHidden, updateReadyGlWindows } from './glTransitionVisibilityState';
import { historyReduce, reduce, type History } from './reduce';
import type { TimelineItem, TimelineState } from './types';
import { docFromTimeline } from '../persist/projectStore';

const clip = (id: string, track: string, kind: 'video' | 'image' = 'video'): TimelineItem => ({
  id,
  track,
  kind,
  name: id,
  src: `/media/uploads/${id}.${kind === 'image' ? 'png' : 'mp4'}`,
  startFrame: 0,
  durationInFrames: 90,
  width: 1920,
  height: 1080,
});

const state = {
  fps: 30,
  width: 1080,
  height: 1920,
  selectedId: 'main-video',
  trackOrder: ['V2', 'V1', 'A1'],
  tracks: {
    V2: { kind: 'video' },
    V1: { kind: 'video' },
    A1: { kind: 'audio' },
  },
  items: [clip('main-video', 'V1'), clip('overlay-video', 'V2'), clip('main-image', 'V1', 'image')],
} as TimelineState;

assert.equal(isBackgroundFillEligible(state, state.items[0]!), true);
assert.equal(isBackgroundFillEligible(state, state.items[1]!), false, 'overlay tracks cannot own a full-canvas background');
assert.equal(isBackgroundFillEligible(state, state.items[2]!), true);

const enabled = reduce(state, { type: 'setBackgroundFill', id: 'main-video', enabled: true });
assert.equal(enabled.items[0]?.backgroundFill, true);
assert.equal(isBackgroundFillActive(enabled, enabled.items[0]!), true);
assert.equal(state.items[0]?.backgroundFill, undefined, 'the reducer keeps the input immutable');

const rejected = reduce(state, { type: 'setBackgroundFill', id: 'overlay-video', enabled: true });
assert.equal(rejected, state, 'invalid overlay-track background fill is a reducer no-op');
const disabled = reduce(enabled, { type: 'setBackgroundFill', id: 'main-video', enabled: false });
assert.equal(disabled.items[0]?.backgroundFill, undefined, 'disabled state is omitted from persistence');

const split = reduce(enabled, { type: 'split', id: 'main-video', atFrame: 45, newId: 'main-video-right' });
assert.equal(split.items.find((item) => item.id === 'main-video')?.backgroundFill, true);
assert.equal(split.items.find((item) => item.id === 'main-video-right')?.backgroundFill, true);
const duplicated = reduce(enabled, { type: 'duplicate', id: 'main-video', newId: 'main-video-copy' });
assert.equal(duplicated.items.find((item) => item.id === 'main-video-copy')?.backgroundFill, true);

let history: History = { past: [], present: docFromTimeline(state), future: [] };
history = historyReduce(history, { type: 'setBackgroundFill', id: 'main-video', enabled: true });
assert.equal(history.present.timelines[0]?.items[0]?.backgroundFill, true);
history = historyReduce(history, { type: 'undo' });
assert.equal(history.present.timelines[0]?.items[0]?.backgroundFill, undefined);
history = historyReduce(history, { type: 'redo' });
assert.equal(history.present.timelines[0]?.items[0]?.backgroundFill, true);

const portrait = backgroundFillAppearance(1080, 1920);
const landscape = backgroundFillAppearance(1920, 1080);
assert.deepEqual(portrait, landscape, 'blur strength follows the canvas short side, not orientation');
assert.ok(portrait.blurPx >= 24 && portrait.blurPx <= 64);
assert.ok(portrait.overscanScale > 1, 'blurred cover layer overscans to hide transparent blur edges');
const filteredBackground = backgroundFillFilter(portrait, { brightness: 1.1, contrast: 0.9, saturate: 1.2, blur: 6 });
assert.match(filteredBackground, new RegExp(`blur\\(${portrait.blurPx + 6}px\\)`), 'user blur is preserved on top of the cover blur');
assert.match(filteredBackground, /contrast\(0\.9\)/);

const faded = { ...state.items[0]!, fadeInFrames: 10, fadeOutFrames: 10, transform: { opacity: 0.8 } };
assert.equal(clipOpacityAt(faded, 0), 0);
assert.equal(clipOpacityAt(faded, 5), 0.4);
assert.equal(clipOpacityAt(faded, 45), 0.8);
assert.ok(Math.abs(clipOpacityAt(faded, 89) - 0.08) < 1e-9, 'foreground and background share fade opacity');

const glWindows = [{ key: 'tr', from: 10, durationInFrames: 20, itemIds: ['main-video', 'next-video'] }];
let readyGlWindows = updateReadyGlWindows(new Set<string>(), 'tr', true);
assert.equal(isGlBaseHidden('main-video', 10, glWindows, readyGlWindows), true);
assert.equal(isGlBaseHidden('main-video', 29, glWindows, readyGlWindows), true);
assert.equal(isGlBaseHidden('main-video', 30, glWindows, readyGlWindows), false);
assert.equal(isGlBaseHidden('overlay-video', 20, glWindows, readyGlWindows), false);
readyGlWindows = updateReadyGlWindows(readyGlWindows, 'tr', false);
assert.equal(isGlBaseHidden('main-video', 20, glWindows, readyGlWindows), false);

console.log('backgroundFill.verify: reducer eligibility, immutable state, undo/redo, and appearance ok');
