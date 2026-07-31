import assert from 'node:assert/strict';
import { reduce } from './reduce';
import { reconcileTransitions } from './transitionReconcile';
import type { TimelineItem, TimelineState, TransitionItem } from './types';

const item = (id: string, startFrame: number, durationInFrames: number, track = 'V1'): TimelineItem => ({
  id,
  track,
  startFrame,
  durationInFrames,
  kind: 'video',
  name: id,
  src: `/media/${id}.mp4`,
});

const transition: TransitionItem = {
  id: 'transition-a-b',
  type: 'cross-dissolve',
  durationInFrames: 30,
  outgoingItemId: 'a',
  incomingItemId: 'b',
  trackId: 'V1',
  enabled: true,
};

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' } },
  trackOrder: ['V1', 'V2'],
  items: [item('a', 0, 40), item('b', 40, 40)],
  transitions: [transition],
};

{
  const clamped = reconcileTransitions(
    [item('a', 0, 12), item('b', 12, 8)],
    [transition],
  );
  assert.equal(clamped[0]?.durationInFrames, 8, 'duration is clamped to both adjacent timeline handles');
  assert.deepEqual(
    reconcileTransitions([item('a', 0, 50), item('x', 40, 10), item('b', 50, 40)], [transition]),
    [],
    'a transition cannot skip the actual adjacent outgoing clip',
  );
}

{
  const seamItems = [item('a', 0, 40), item('covering', 20, 40), item('b', 40, 40)];
  assert.deepEqual(
    reconcileTransitions(seamItems, [transition]),
    [],
    'a compatible third clip crossing the endpoint seam makes the cut non-binary',
  );
  assert.deepEqual(
    reconcileTransitions([seamItems[1]!, seamItems[0]!, seamItems[2]!], [transition]),
    [],
    'a crossing third clip is rejected independently of item array order',
  );
  assert.deepEqual(
    reconcileTransitions([item('a', 0, 40), item('touching', 40, 10), item('b', 40, 40)], [transition]),
    [transition],
    'a compatible third clip that only touches the seam does not invalidate the cut',
  );
  assert.deepEqual(
    reconcileTransitions([item('a', 0, 40), item('other-track', 20, 40, 'V2'), item('b', 40, 40)], [transition]),
    [transition],
    'a crossing clip on another track does not invalidate the cut',
  );
  assert.deepEqual(
    reconcileTransitions([
      item('a', 0, 40),
      { ...item('audio-bed', 20, 40), kind: 'audio' },
      item('b', 40, 40),
    ], [transition]),
    [transition],
    'an incompatible crossing clip on the same track does not invalidate the cut',
  );
}

{
  const moved = reduce(state, { type: 'move', id: 'b', track: 'V2', startFrame: 40 });
  assert.deepEqual(moved.transitions, [], 'moving an endpoint to another track removes the transition');
}

{
  const retimed = reduce(state, { type: 'retime', id: 'a', durationInFrames: 30 });
  assert.deepEqual(retimed.transitions, [], 'retiming away from the shared seam removes the transition');

  const shorterIncoming = reduce(state, { type: 'retime', id: 'b', durationInFrames: 5 });
  assert.equal(shorterIncoming.transitions?.[0]?.durationInFrames, 5, 'retime clamps a still-valid transition to the shorter handle');
}

{
  const splitOutgoing = reduce(state, { type: 'split', id: 'a', atFrame: 20, newId: 'a-right' });
  assert.deepEqual(
    splitOutgoing.transitions,
    [{ ...transition, outgoingItemId: 'a-right', durationInFrames: 20 }],
    'splitting the outgoing endpoint transfers the original right-edge transition to the right fragment',
  );

  const splitIncoming = reduce(state, { type: 'split', id: 'b', atFrame: 50, newId: 'b-right' });
  assert.equal(splitIncoming.transitions?.[0]?.incomingItemId, 'b', 'a valid endpoint is never guessed or retargeted');
  assert.equal(splitIncoming.transitions?.[0]?.durationInFrames, 10, 'split clamps the surviving transition to the left segment handle');
}

{
  const removed = reduce(state, { type: 'remove', id: 'a' });
  assert.deepEqual(removed.transitions, [], 'removing either endpoint cannot leave a dangling reference');
}

console.log('transitionReconcile.verify: ok (adjacency/type/seam validation + reducer move/retime/split/remove)');
