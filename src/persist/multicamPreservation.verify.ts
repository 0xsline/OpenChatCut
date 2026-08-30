// Multicam/link group normalization must repair what it can instead of
// discarding a whole group: normalizeTimelineGroups runs on EVERY load, and
// the next save makes the discard permanent.
// npx tsx src/persist/multicamPreservation.verify.ts
import assert from 'node:assert/strict';
import type { Timeline, TimelineItem } from '../editor/types';
import { normalizeTimelineGroups } from './migrations/normalize';

const item = (id: string): TimelineItem => ({
  id, track: 'V1', startFrame: 0, durationInFrames: 60,
  kind: 'video', name: id, src: `/${id}.mp4`,
} as TimelineItem);

const angle = (id: string, over: Record<string, unknown> = {}) => ({
  id, itemId: id, label: id, offsetFrames: 0, confidence: 0.9, source: item(id), ...over,
});

const groupWith = (angles: unknown[], evidence: unknown[]): Timeline => ({
  id: 'tl1', name: '序列 1', fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [item('a'), item('b')],
  multicamGroups: [{
    id: 'g1', angles, referenceAngleId: 'a', masterAngleId: 'a', syncMethod: 'audio', evidence,
  }],
} as unknown as Timeline);

const evidenceFor = (angleId: string, confidence = 0.8) => ({
  angleId, method: 'audio', confidence, offsetFrames: 0,
});

// ── 完整数据保持不变 ──────────────────────────────────────────────────────
{
  const out = normalizeTimelineGroups(groupWith(
    [angle('a'), angle('b')],
    [evidenceFor('a'), evidenceFor('b')],
  ));
  assert.equal(out.multicamGroups?.length, 1, 'a complete group survives');
  assert.equal(out.multicamGroups?.[0]?.angles.length, 2);
}

// ── confidence 浮点越界:clamp 而非丢组 ────────────────────────────────────
{
  const out = normalizeTimelineGroups(groupWith(
    [angle('a', { confidence: 1.0000000000000002 }), angle('b')],
    [evidenceFor('a'), evidenceFor('b')],
  ));
  assert.equal(out.multicamGroups?.length, 1,
    'float noise above 1 must not delete the group');
  assert.equal(out.multicamGroups?.[0]?.angles[0]?.confidence, 1, 'confidence is clamped to 1');

  const negative = normalizeTimelineGroups(groupWith(
    [angle('a', { confidence: -0.0001 }), angle('b')],
    [evidenceFor('a'), evidenceFor('b')],
  ));
  assert.equal(negative.multicamGroups?.[0]?.angles[0]?.confidence, 0, 'clamped to 0 below range');
}

// ── evidence 越界同样 clamp ───────────────────────────────────────────────
{
  const out = normalizeTimelineGroups(groupWith(
    [angle('a'), angle('b')],
    [evidenceFor('a', 1.5), evidenceFor('b')],
  ));
  assert.equal(out.multicamGroups?.length, 1, 'out-of-range evidence confidence does not drop the group');
  const clamped = out.multicamGroups?.[0]?.evidence.find((e) => e.angleId === 'a');
  assert.equal(clamped?.confidence, 1, 'evidence confidence is clamped');
}

// ── 某个 angle 缺 evidence:保留分组(evidence 是溯源,不是结构要求) ───────────
{
  const out = normalizeTimelineGroups(groupWith(
    [angle('a'), angle('b')],
    [evidenceFor('a')],
  ));
  assert.equal(out.multicamGroups?.length, 1,
    'an angle without evidence must NOT discard the whole group');
  assert.equal(out.multicamGroups?.[0]?.angles.length, 2, 'both angles are kept');
  assert.equal(out.multicamGroups?.[0]?.evidence.length, 1, 'only real evidence is kept — never synthesized');
}

// ── 真正的结构性损坏仍然被拒 ──────────────────────────────────────────────
{
  const brokenAngle = normalizeTimelineGroups(groupWith(
    [angle('a'), { id: 'b', label: 'b' }],
    [evidenceFor('a')],
  ));
  // An empty result is normalized to `undefined` by normalizeTimelineGroups.
  assert.equal(brokenAngle.multicamGroups?.length ?? 0, 0,
    'fewer than two structurally valid angles is still rejected');

  const nonFinite = normalizeTimelineGroups(groupWith(
    [angle('a', { confidence: Number.NaN }), angle('b')],
    [evidenceFor('a'), evidenceFor('b')],
  ));
  assert.equal(nonFinite.multicamGroups?.length ?? 0, 0,
    'NaN confidence is not clampable and is still rejected');
}

console.log('multicamPreservation.verify: ok');
