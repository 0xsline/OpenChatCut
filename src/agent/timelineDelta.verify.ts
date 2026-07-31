// Runnable check: `npx tsx src/agent/timelineDelta.verify.ts`.
// Covers reconstructable typed property changes, contiguous-only shift compression,
// deletion/new-track reporting, the 30-item limit, and a real reducer ripple.
import assert from 'node:assert/strict';
import { describeTimelineDelta, snapshotTimeline } from './timelineDelta';
import { reduce } from '../editor/reduce';
import type { TimelineItem, TimelineState } from '../editor/types';

const clip = (id: string, track: string, startFrame: number, dur = 30): TimelineItem =>
  ({ id, track, startFrame, durationInFrames: dur, kind: 'video', name: id, src: `/m/${id}.mp4` } as TimelineItem);

// The original track id is intentionally not called V1/V2: the alias is derived from the position (video track bottom up V1..Vn),
// Using the same name will mix the "original id" and the "alias" together. trackOrder top down.
const TRACKS = { 'trk-upper': { kind: 'video' as const }, 'trk-lower': { kind: 'video' as const } };
const stateOf = (items: TimelineItem[], tracks: Record<string, { kind: 'video' | 'audio' }> = TRACKS): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks,
  trackOrder: Object.keys(tracks),
  items,
});

// ── Read-only: status unchanged → null (do not add any fields to the result) ──
{
  const s = stateOf([clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30)]);
  assert.equal(describeTimelineDelta(snapshotTimeline(s), s), null, '无变化不产出差分');
}

// ── Create new / change track / change length → enter clips one by one ──
{
  const before = snapshotTimeline(stateOf([clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30)]));
  const after = stateOf([
    { ...clip('a', 'trk-lower', 0), durationInFrames: 45 } as TimelineItem, // Change length
    clip('b', 'trk-upper', 30),                                             // change track
    clip('c', 'trk-lower', 90),                                             // New
  ]);
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.clips?.length, 3, '三类变更都进 clips');
  assert.deepEqual(d.clips?.map((c) => c.id).sort(), ['a', 'b', 'c']);
  assert.equal(d.shifted, undefined, '这些都不是纯位移');
  const a = d.clips!.find((c) => c.id === 'a')!;
  assert.equal(a.durationInFrames, 45, 'clips 带新状态而不是旧状态');
  assert.equal(a.track, 'V1', 'track 报别名(最下方视频轨 = V1),与 read_project 一致');
}

// ── Corrugation: Same track and same displacement ≥3 → compressed into one rule, not listed one by one ──
{
  const items = [clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30), clip('c', 'trk-lower', 60), clip('d', 'trk-lower', 90), clip('e', 'trk-lower', 120)];
  const before = snapshotTimeline(stateOf(items));
  // Delete a and shift the next four to the left by 30 each
  const after = stateOf(items.slice(1).map((it) => ({ ...it, startFrame: it.startFrame - 30 })));
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.clips, undefined, '纯位移不进 clips');
  assert.deepEqual(d.shifted, [{ track: 'V1', fromFrame: 30, by: -30, count: 4 }], '压成一条规则');
  assert.deepEqual(d.removedItemIds, ['a'], '删除单独上报');
}

// ── Sporadic displacement (<3) → Return to enumeration one by one, do not press the rules ──
{
  const items = [clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30), clip('c', 'trk-lower', 60)];
  const before = snapshotTimeline(stateOf(items));
  const after = stateOf([items[0]!, { ...items[1]!, startFrame: 40 }, { ...items[2]!, startFrame: 70 }]);
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.shifted, undefined, '2 个不压规则');
  assert.deepEqual(d.clips?.map((c) => c.id), ['b', 'c'], '逐条列出');
}

// ── Different rails/different displacements are grouped into groups ──
{
  const items = [
    ...[0, 30, 60].map((f, i) => clip(`v${i}`, 'trk-lower', f)),
    ...[0, 30, 60].map((f, i) => clip(`w${i}`, 'trk-upper', f)),
  ];
  const before = snapshotTimeline(stateOf(items));
  const after = stateOf(items.map((it) => ({
    ...it, startFrame: it.startFrame + (it.track === 'trk-lower' ? 10 : 20),
  })));
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.shifted?.length, 2, '两轨两条规则');
  assert.deepEqual(d.shifted?.map((r) => [r.track, r.by, r.count]).sort(), [['V1', 10, 3], ['V2', 20, 3]]);
}

// ── Upper limit: if there are more than 30 entries, only the top 30 will be listed and prompted to re-read──
{
  const items = Array.from({ length: 40 }, (_, i) => clip(`c${i}`, 'trk-lower', i * 30));
  const before = snapshotTimeline(stateOf(items));
  // Change the length of each one (not pure displacement) → all count as changes
  const after = stateOf(items.map((it) => ({ ...it, durationInFrames: 20 })));
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.clips?.length, 30, '最多列 30 条');
  assert.match(d.notes?.join(' ') ?? '', /共 40 个片段变更/, '提示总数与重读');
}

// ── New track reporting + track composition change reminder ──
{
  const before = snapshotTimeline(stateOf([clip('a', 'trk-lower', 0)], { 'trk-lower': { kind: 'video' } }));
  const after = stateOf([clip('a', 'trk-lower', 0), clip('b', 'trk-upper', 0)]); // Add a new video track above
  const d = describeTimelineDelta(before, after)!;
  assert.deepEqual(d.createdTracks, ['V2'], '新轨上报(按别名:新轨在上 = V2)');
  assert.match(d.notes?.join(' ') ?? '', /轨道构成已变化/, '提醒重新确认轨道定位');
}

// ── Ripple removal by real reducer: difference is consistent with actual result ──
{
  const items = [clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30), clip('c', 'trk-lower', 60), clip('d', 'trk-lower', 90)];
  const s0 = stateOf(items);
  const before = snapshotTimeline(s0);
  const s1 = reduce(s0, { type: 'remove', id: 'a', ripple: true });
  const d = describeTimelineDelta(before, s1)!;
  assert.deepEqual(d.removedItemIds, ['a'], '真 reducer 删除');
  assert.equal(d.shifted?.length, 1, '波纹压成一条规则');
  assert.equal(d.shifted![0]!.count, 3, '后面 3 个片段位移');
  assert.equal(d.shifted![0]!.by, -30, '各左移 30 帧');
  // Rules can infer the true position
  for (const it of s1.items) {
    const was = before.placements.get(it.id)!;
    assert.equal(it.startFrame, was.startFrame + d.shifted![0]!.by, `${it.id} 位置可由规则推出`);
  }
}

// ── Same displacement is not compressed when moved items are not a contiguous range ──
{
  const items = Array.from({ length: 6 }, (_, index) =>
    clip(String.fromCharCode(97 + index), 'trk-lower', index * 30));
  const before = snapshotTimeline(stateOf(items));
  const movedIds = new Set(['a', 'c', 'e']);
  const after = stateOf(items.map((item) =>
    movedIds.has(item.id) ? { ...item, startFrame: item.startFrame + 10 } : item));
  const delta = describeTimelineDelta(before, after)!;
  assert.equal(delta.shifted, undefined, 'non-contiguous moves must retain item-level identity');
  assert.deepEqual(delta.clips?.map((item) => item.id), ['a', 'c', 'e']);
  assert.deepEqual(
    delta.changes
      ?.filter((change) => change.entity === 'item' && change.field === 'startFrame')
      .map((change) => change.itemId),
    ['a', 'c', 'e'],
    'uncompressed shifts include typed item IDs and before/after positions',
  );
}

// ── Attribute and transition changes are typed with before/after values ──
{
  const original = {
    ...clip('rich', 'trk-lower', 0),
    src: '/m/old.mp4',
    props: { text: 'Before', opacity: 1, color: '#fff' },
    volume: 1,
    transform: { crop: { left: 0.1 }, scale: 1 },
    effects: [{ id: 'fx-a', assetId: 'builtin:fx-blur', overrides: { amount: 1 } }],
  } as TimelineItem;
  const beforeState = {
    ...stateOf([original]),
    transitions: [{
      id: 'tr-a',
      type: 'cross-dissolve',
      durationInFrames: 12,
      outgoingItemId: 'out',
      incomingItemId: 'rich',
      trackId: 'trk-lower',
    }],
  } as TimelineState;
  const before = snapshotTimeline(beforeState);
  const changed = {
    ...original,
    src: '/m/new.mp4',
    props: { text: 'After', opacity: 0.5, color: '#fff' },
    volume: 0.4,
    transform: { crop: { left: 0.2, right: 0.1 }, scale: 1 },
    effects: [{ id: 'fx-b', assetId: 'builtin:fx-pixelate', overrides: { amount: 2 } }],
  } as TimelineItem;
  const afterState = {
    ...stateOf([changed]),
    transitions: [{
      ...beforeState.transitions![0]!,
      durationInFrames: 24,
    }],
  } as TimelineState;
  const delta = describeTimelineDelta(before, afterState)!;
  const fields = delta.changes
    ?.filter((change) => change.entity === 'item')
    .map((change) => change.field) ?? [];
  for (const expected of ['text', 'src', 'opacity', 'volume', 'crop', 'effects']) {
    assert.ok(fields.includes(expected as typeof fields[number]), `reports ${expected} change`);
  }
  const textChange = delta.changes?.find((change) =>
    change.entity === 'item' && change.field === 'text');
  assert.deepEqual(
    textChange && { before: textChange.before, after: textChange.after },
    { before: 'Before', after: 'After' },
    'typed changes carry values needed to update the agent timeline model',
  );
  const transitionChange = delta.changes?.find((change) => change.entity === 'transition');
  assert.equal(transitionChange?.before?.durationInFrames, 12);
  assert.equal(transitionChange?.after?.durationInFrames, 24);
}

console.log('timelineDelta.verify: ok (typed properties/transitions, contiguous shifts, limits, tracks, reducer ripple)');
