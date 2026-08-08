import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
