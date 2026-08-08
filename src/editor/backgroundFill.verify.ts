import assert from 'node:assert/strict';
import {
  backgroundFillAppearance,
  backgroundFillAppearanceFor,
  backgroundFillFilter,
  backgroundFillStrengthOf,
  isBackgroundFillActive,
  isBackgroundFillEligible,
  isBackgroundFillStrength,
} from './backgroundFill';
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
const custom = reduce(enabled, {
  type: 'setBackgroundFill',
  id: 'main-video',
  enabled: true,
  strength: 73,
});
assert.equal(custom.items[0]?.backgroundFillStrength, 73);
assert.equal(backgroundFillStrengthOf(enabled.items[0]!), 50, 'enabled fills default to 50%');
const resetToDefault = reduce(custom, {
  type: 'setBackgroundFill',
  id: 'main-video',
  enabled: true,
  strength: 50,
});
assert.equal(resetToDefault.items[0]?.backgroundFillStrength, undefined,
  'the default percentage is omitted from persistence');
assert.equal(reduce(custom, {
  type: 'setBackgroundFill', id: 'main-video', enabled: true, strength: 101,
}), custom, 'out-of-range reducer input is rejected');

const rejected = reduce(state, { type: 'setBackgroundFill', id: 'overlay-video', enabled: true });
assert.equal(rejected, state, 'invalid overlay-track background fill is a reducer no-op');
const disabled = reduce(custom, { type: 'setBackgroundFill', id: 'main-video', enabled: false });
assert.equal(disabled.items[0]?.backgroundFill, undefined, 'disabled state is omitted from persistence');
assert.equal(disabled.items[0]?.backgroundFillStrength, undefined, 'disabling also clears the dormant strength');

const split = reduce(custom, { type: 'split', id: 'main-video', atFrame: 45, newId: 'main-video-right' });
assert.equal(split.items.find((item) => item.id === 'main-video')?.backgroundFillStrength, 73);
assert.equal(split.items.find((item) => item.id === 'main-video-right')?.backgroundFillStrength, 73);
const duplicated = reduce(custom, { type: 'duplicate', id: 'main-video', newId: 'main-video-copy' });
assert.equal(duplicated.items.find((item) => item.id === 'main-video-copy')?.backgroundFillStrength, 73);

let history: History = { past: [], present: docFromTimeline(state), future: [] };
history = historyReduce(history, {
  type: 'setBackgroundFill',
  id: 'main-video',
  enabled: true,
  strength: 100,
});
assert.equal(history.present.timelines[0]?.items[0]?.backgroundFillStrength, 100);
history = historyReduce(history, { type: 'undo' });
assert.equal(history.present.timelines[0]?.items[0]?.backgroundFill, undefined);
history = historyReduce(history, { type: 'redo' });
assert.equal(history.present.timelines[0]?.items[0]?.backgroundFillStrength, 100);

const portrait = backgroundFillAppearance(1080, 1920);
const landscape = backgroundFillAppearance(1920, 1080);
assert.deepEqual(portrait, landscape, 'blur strength follows the canvas short side, not orientation');
assert.ok(portrait.blurPx >= 24 && portrait.blurPx <= 64);
assert.ok(portrait.overscanScale > 1, 'blurred cover layer overscans to hide transparent blur edges');
const none = backgroundFillAppearance(1080, 1920, 0);
const light = backgroundFillAppearance(1080, 1920, 25);
const customAppearance = backgroundFillAppearance(1080, 1920, 63);
const strongAppearance = backgroundFillAppearance(1080, 1920, 75);
const maximum = backgroundFillAppearance(1080, 1920, 100);
const customItemAppearance = backgroundFillAppearanceFor(
  { backgroundFillStrength: 63 },
  1080,
  1920,
);
assert.deepEqual(customItemAppearance, customAppearance, 'every render path resolves the exact item percentage');
assert.equal(none.blurPx, 0);
assert.equal(isBackgroundFillStrength(73.5), false, 'persisted percentages are exact whole numbers');
assert.deepEqual(
  [light.blurPx, portrait.blurPx, strongAppearance.blurPx, maximum.blurPx],
  [22, 38, 54, 70],
  'the four percentage shortcuts preserve the legacy preset appearance',
);
assert.deepEqual(
  [light.brightness, portrait.brightness, strongAppearance.brightness, maximum.brightness],
  [0.82, 0.72, 0.68, 0.64],
);
assert.ok(none.blurPx < light.blurPx);
assert.ok(light.blurPx < portrait.blurPx);
assert.ok(portrait.blurPx < customAppearance.blurPx);
assert.ok(customAppearance.blurPx < strongAppearance.blurPx);
assert.ok(strongAppearance.blurPx < maximum.blurPx, 'percentage strength increases blur monotonically');
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
