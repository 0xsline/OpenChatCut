// Pure-logic check for multi-select move / remove. Run: npx tsx src/editor/multiSelect.check.ts
import assert from 'node:assert/strict';
import { groupMoveIds, moveItemsByDelta, removeItemsFromState } from './multiSelect';
import type { TimelineItem, TimelineState } from './types';

const clip = (id: string, start: number, track = 'V1'): TimelineItem => ({
  id, name: id, kind: 'motion-graphic', track, startFrame: start, durationInFrames: 30,
});

const base: TimelineState = {
  fps: 30, width: 1920, height: 1080,
  selectedId: 'c',
  selectedIds: ['a', 'b', 'c'],
  items: [clip('a', 0), clip('b', 40), clip('c', 80), clip('d', 120)],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
  trackOrder: ['V2', 'V1', 'A1'],
};

{
  const ids = groupMoveIds(base, 'b');
  assert.deepEqual(ids, ['a', 'b', 'c'], 'group move uses full multi-selection');
  assert.deepEqual(groupMoveIds(base, 'd'), ['d'], 'unselected grab is single');
}

{
  const next = moveItemsByDelta(base, ['a', 'b', 'c'], 10, null);
  assert.equal(next.items.find((x) => x.id === 'a')!.startFrame, 10);
  assert.equal(next.items.find((x) => x.id === 'b')!.startFrame, 50);
  assert.equal(next.items.find((x) => x.id === 'c')!.startFrame, 90);
  assert.equal(next.items.find((x) => x.id === 'd')!.startFrame, 120, 'non-selected stays');
}

{
  // primary V1 → V2 is index -1 in trackOrder [V2,V1,A1]
  const next = moveItemsByDelta(base, ['a', 'b'], 0, { from: 'V1', to: 'V2' });
  assert.equal(next.items.find((x) => x.id === 'a')!.track, 'V2');
  assert.equal(next.items.find((x) => x.id === 'b')!.track, 'V2');
}

{
  const next = removeItemsFromState(base, ['a', 'b', 'c'], false);
  assert.deepEqual(next.items.map((x) => x.id), ['d']);
  assert.equal(next.selectedId, null);
  assert.deepEqual(next.selectedIds, []);
}

{
  // ripple: remove b (40..70), c starts at 80 → shift left by 30 → 50
  const oneTrack: TimelineState = {
    ...base,
    selectedIds: ['b'],
    items: [clip('a', 0), clip('b', 40), clip('c', 80)],
  };
  const next = removeItemsFromState(oneTrack, ['b'], true);
  assert.equal(next.items.find((x) => x.id === 'c')!.startFrame, 50);
  assert.ok(!next.items.find((x) => x.id === 'b'));
}

console.log('multiSelect.check.ts: ok');
