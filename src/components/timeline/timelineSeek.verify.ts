import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTimelineRulerScrub } from './timelineRulerScrub';
import {
  attachPlayheadMediaSync,
} from './usePlayheadPaint';
import {
  seekTimelineFromPointer,
  timelineGestureHasDragged,
  timelinePointerShouldSeek,
  timelineSeekFrameAtClientX,
} from './timelineSeek';

const geometry = {
  contentLeft: 100,
  headerWidth: 112,
  pixelsPerFrame: 2,
  totalFrames: 120,
};

assert.equal(timelineSeekFrameAtClientX(212, geometry), 0);
assert.equal(timelineSeekFrameAtClientX(312, geometry), 50);
assert.equal(timelineSeekFrameAtClientX(451, geometry), 119);
assert.equal(timelineSeekFrameAtClientX(452, geometry), null);
assert.equal(timelineSeekFrameAtClientX(211, geometry), null);
assert.equal(timelineSeekFrameAtClientX(312, { ...geometry, totalFrames: 0 }), null);

assert.equal(timelinePointerShouldSeek(0, false, false), true);
assert.equal(timelinePointerShouldSeek(2, false, false), false);
assert.equal(timelinePointerShouldSeek(0, true, false), false);
assert.equal(timelinePointerShouldSeek(0, false, true), false);

assert.equal(timelineGestureHasDragged(10, 10, 13, 13), false);
assert.equal(timelineGestureHasDragged(10, 10, 14, 10), true);
assert.equal(timelineGestureHasDragged(10, 10, 10, 14), true);

const pointerSeekCalls: string[] = [];
seekTimelineFromPointer({
  pause: () => pointerSeekCalls.push('pause'),
  seekTo: (frame) => pointerSeekCalls.push(`seek:${frame}`),
}, 42, (frame) => pointerSeekCalls.push(`paint:${frame}`));
assert.deepEqual(
  pointerSeekCalls,
  ['pause', 'seek:42', 'paint:42'],
  'pointer seeking must pause before moving and painting the playhead',
);

const detachedPointerPaints: number[] = [];
seekTimelineFromPointer(null, 17, (frame) => detachedPointerPaints.push(frame));
assert.deepEqual(
  detachedPointerPaints,
  [17],
  'pointer seeking must still paint when the preview player is not mounted',
);

class TestRuler extends EventTarget {
  style = { cursor: 'pointer' };
  captured: number | null = null;
  setPointerCapture(pointer: number) { this.captured = pointer; }
  hasPointerCapture(pointer: number) { return this.captured === pointer; }
  releasePointerCapture() { this.captured = null; }
  send(type: string, clientX: number) {
    this.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, clientX }));
  }
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let timestamp = 0;
const stepScroll = () => {
  const pending = [...frames.values()];
  frames.clear();
  timestamp = Math.max(timestamp, performance.now()) + 16;
  for (const callback of pending) callback(timestamp);
};
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++nextFrame, callback);
  return nextFrame;
};
globalThis.cancelAnimationFrame = (handle) => { frames.delete(handle); };
try {
  const ruler = new TestRuler();
  const viewport = {
    clientLeft: 0, clientWidth: 500, scrollWidth: 2000, scrollLeft: 250,
    getBoundingClientRect: () => ({ left: 100 }),
  };
  const observed: { x: number; scroll: number }[] = [];
  const start = () => startTimelineRulerScrub(
    ruler as unknown as HTMLElement, viewport as unknown as HTMLElement, 1, 350,
    () => ({
      headerWidth: 112, pixelsPerFrame: 4, totalFrames: 300,
      seekTo: (x) => observed.push({ x, scroll: viewport.scrollLeft }),
    }),
  );
  start();
  assert.deepEqual(observed.at(-1), { x: 350, scroll: 250 });
  ruler.send('pointermove', 700);
  stepScroll();
  stepScroll();
  assert.equal(observed.at(-1)?.x, 592, 'the cursor remains inside the right edge');
  assert.ok(viewport.scrollLeft > 250, 'a held drag keeps scrolling without pointer movement');
  ruler.send('pointermove', 350);
  const insideScroll = viewport.scrollLeft;
  stepScroll();
  assert.equal(viewport.scrollLeft, insideScroll);
  assert.equal(observed.at(-1)?.x, 350);
  ruler.send('pointermove', 150);
  stepScroll();
  assert.equal(observed.at(-1)?.x, 220, 'the cursor stays to the right of the sticky header');
  assert.ok(viewport.scrollLeft < insideScroll);
  ruler.send('pointerup', 150);
  assert.equal(frames.size, 0);
  assert.equal(ruler.style.cursor, 'pointer');
  assert.equal(ruler.captured, null);

  viewport.scrollLeft = 2;
  const stopLeft = start();
  ruler.send('pointermove', 150);
  stepScroll();
  assert.deepEqual(observed.at(-1), { x: 212, scroll: 0 }, 'the left edge can reach frame zero');
  assert.equal(frames.size, 0);
  stopLeft();

  viewport.scrollLeft = 804;
  start();
  ruler.send('pointermove', 700);
  stepScroll();
  assert.deepEqual(observed.at(-1), { x: 592, scroll: 816 }, 'scroll stops at the last frame');
  assert.equal(frames.size, 0);
  ruler.send('pointermove', 150);
  assert.equal(frames.size, 1);
  ruler.send('lostpointercapture', 150);
  assert.equal(frames.size, 0);
} finally {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
}

type FrameListener = (event: { detail: { frame: number } }) => void;

class MetadataContainer extends EventTarget {
  captureEnabled = false;
  private readonly metadataListeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type !== 'loadedmetadata') return super.addEventListener(type, callback, options);
    this.captureEnabled = typeof options === 'boolean' ? options : options?.capture === true;
    if (callback && this.captureEnabled) this.metadataListeners.add(callback);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (type !== 'loadedmetadata') return super.removeEventListener(type, callback);
    if (callback) this.metadataListeners.delete(callback);
  }

  dispatchFromDescendant(): void {
    const event = {
      type: 'loadedmetadata',
      bubbles: false,
      target: { tagName: 'VIDEO' },
      currentTarget: this,
    } as unknown as Event;
    for (const listener of this.metadataListeners) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

class SyncPlayer {
  readonly seeks: number[] = [];
  private readonly frameListeners = new Set<FrameListener>();
  private readonly container: EventTarget | null;

  constructor(container: EventTarget | null) {
    this.container = container;
  }

  getContainerNode(): EventTarget | null { return this.container; }
  seekTo(frame: number): void { this.seeks.push(frame); }
  addEventListener(_type: 'frameupdate', listener: FrameListener): void { this.frameListeners.add(listener); }
  removeEventListener(_type: 'frameupdate', listener: FrameListener): void { this.frameListeners.delete(listener); }
  emitFrame(frame: number): void {
    for (const listener of this.frameListeners) listener({ detail: { frame } });
  }
}

const firstContainer = new MetadataContainer();
const firstPlayer = new SyncPlayer(firstContainer);
let desiredFirstFrame = 150;
const detachFirstSync = attachPlayheadMediaSync(
  firstPlayer,
  () => desiredFirstFrame,
  (event) => { desiredFirstFrame = event.detail.frame; },
);
firstContainer.dispatchFromDescendant();
assert.equal(firstContainer.captureEnabled, true, 'descendant media metadata must use capture');
assert.deepEqual(firstPlayer.seeks, [150], 'media metadata must reassert the restored preview frame');
firstPlayer.emitFrame(210);
firstContainer.dispatchFromDescendant();
assert.deepEqual(firstPlayer.seeks, [150, 210], 'late metadata must preserve a newer frameupdate');

detachFirstSync();
firstPlayer.emitFrame(225);
firstContainer.dispatchFromDescendant();
assert.deepEqual(firstPlayer.seeks, [150, 210], 'detached players must be inert');

const secondContainer = new MetadataContainer();
const secondPlayer = new SyncPlayer(secondContainer);
let desiredSecondFrame = 240;
const detachSecondSync = attachPlayheadMediaSync(
  secondPlayer,
  () => desiredSecondFrame,
  (event) => { desiredSecondFrame = event.detail.frame; },
);
secondContainer.dispatchFromDescendant();
assert.deepEqual(secondPlayer.seeks, [240], 'replacement players must synchronize independently');
detachSecondSync();
assert.doesNotThrow(() => attachPlayheadMediaSync(
  new SyncPlayer(null),
  () => 0,
  () => undefined,
)());

const timelineSource = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
assert.match(timelineSource, /onPointerDownCapture=\{startSeekGesture\}/);
const controllerSource = readFileSync(new URL('./useTimelineController.ts', import.meta.url), 'utf8');
assert.match(controllerSource, /onHoverPreviewFrameChange\?\.\(frame\)/);
assert.match(timelineSource, /className="cc-timeline-hover-guide"/);

const previewSource = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(previewSource, /hoverPreviewFrame !== null/);
assert.match(previewSource, /<Thumbnail[\s\S]*?frameToDisplay=\{hoverPreviewFrame\}/);

console.log('timelineSeek.verify: frame mapping and drag-safe seeking passed');
