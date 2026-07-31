// Runnable check: `npx tsx src/editor/slip.verify.ts`.
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { editedStreamFrames, itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { historyReduce, reduce, type History } from './reduce';
import { planSlip, slipPreview } from './slip';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem, TimelineState } from './types';

const asset: MediaAsset = {
  id: 'asset-a',
  name: 'Source A',
  kind: 'video',
  src: '/media/uploads/a.mp4',
  durationInFrames: 300,
};

const item = (playbackRate: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: 'clip-a',
  track: 'video-main',
  startFrame: 100,
  durationInFrames: 60,
  name: 'Clip A',
  kind: 'video',
  src: asset.src,
  srcInFrame: 30,
  playbackRate,
  ...patch,
});

const transcript = [
  { text: 'keep-left', start: 0, end: 1_000 },
  { text: 'delete-middle', start: 1_000, end: 9_000 },
  { text: 'keep-right', start: 9_000, end: 10_000 },
];

const transcriptItem = (playbackRate: number, patch: Partial<TimelineItem> = {}): TimelineItem =>
  item(playbackRate, {
    kind: 'audio',
    track: 'audio-main',
    durationInFrames: 30,
    srcInFrame: 15,
    transcript,
    deletedWordIdx: [1],
    ...patch,
  });

const stateOf = (candidate: TimelineItem): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [candidate],
  assets: [asset],
  selectedId: candidate.id,
  selectedIds: [candidate.id],
  trackOrder: [candidate.track],
  tracks: { [candidate.track]: { kind: candidate.kind === 'audio' ? 'audio' : 'video' } },
});

for (const [rate, expectedSrcIn] of [
  [1, 50],
  [0.5, 40],
  [2, 70],
] as const) {
  const state = stateOf(item(rate));
  const before = state.items[0]!;
  const next = reduce(state, { type: 'slip', id: before.id, deltaInFrames: 20 });
  const after = next.items[0]!;
  assert.equal(after.srcInFrame, expectedSrcIn, `${rate}x converts timeline delta through the source-time contract`);
  assert.deepEqual(
    { startFrame: after.startFrame, durationInFrames: after.durationInFrames, track: after.track },
    { startFrame: before.startFrame, durationInFrames: before.durationInFrames, track: before.track },
    'slip changes only the source window, never timeline placement or duration',
  );
}

for (const [rate, expectedSrcIn] of [
  [1, 50],
  [0.5, 40],
  [2, 70],
] as const) {
  const state = stateOf(item(rate, { kind: 'audio', track: 'audio-main' }));
  const next = reduce(state, { type: 'slip', id: 'clip-a', deltaInFrames: 20 });
  assert.equal(
    next.items[0]!.srcInFrame,
    expectedSrcIn,
    `ordinary audio at ${rate}x keeps the continuous source-media conversion`,
  );
}

{
  const state = stateOf(item(1, { srcInFrame: 10 }));
  const plan = planSlip(state, 'clip-a', -100);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.srcInFrame, 0);
    assert.equal(plan.appliedDeltaInFrames, -10);
    assert.equal(plan.clamped, true);
  }
}

{
  const state = stateOf(item(2, { srcInFrame: 170 }));
  const plan = planSlip(state, 'clip-a', 100);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.srcInFrame, 180, '2x source span is 120 frames, leaving a maximum in-point of 180');
    assert.equal(plan.appliedDeltaInFrames, 5, '10 available source frames equal 5 timeline frames at 2x');
    assert.equal(plan.sourceDomain, 'media');
    assert.equal(plan.sourceWindow.endFrame, asset.durationInFrames);
    assert.equal(plan.clamped, true);
  }
}

{
  for (const rate of [0.5, 1, 2]) {
    const candidate = transcriptItem(rate);
    const plan = planSlip(stateOf(candidate), candidate.id, 10);
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.equal(plan.srcInFrame, 25, `word-driven audio at ${rate}x moves 1:1 in edited-stream frames`);
      assert.equal(plan.appliedDeltaInFrames, 10);
      assert.equal(plan.sourceDomain, 'edited-stream');
      assert.deepEqual(plan.sourceWindow, { startFrame: 25, endFrame: 55 });
    }
  }
}

{
  const candidate = transcriptItem(2);
  const preview = slipPreview(stateOf(candidate), candidate.id, 999);
  assert.ok(preview);
  assert.equal(preview?.plan.sourceDomain, 'edited-stream');
  assert.deepEqual(preview?.plan.sourceWindow, { startFrame: 30, endFrame: 60 });
  assert.equal(
    preview?.sourceOutFrame,
    59,
    '2x transcript preview and inspector use the edited-stream outpoint instead of multiplying by playbackRate',
  );
}

{
  const candidate = transcriptItem(2);
  const deleted = new Set(candidate.deletedWordIdx);
  const editOpts = itemEditOpts(candidate);
  const total = editedStreamFrames(transcript, deleted, 30, editOpts);
  assert.equal(total, 60, 'deleted middle word leaves a 60-frame edited stream, not the 300-frame asset');

  for (const [delta, expectedSrcIn] of [
    [-999, 0],
    [999, 30],
  ] as const) {
    const plan = planSlip(stateOf(candidate), candidate.id, delta);
    assert.equal(plan.ok, true);
    if (!plan.ok) continue;
    assert.equal(plan.srcInFrame, expectedSrcIn);
    assert.ok(plan.sourceWindow.startFrame >= 0);
    assert.ok(plan.sourceWindow.endFrame <= total, 'slip window stays inside the edited stream');

    const slipped = { ...candidate, srcInFrame: plan.srcInFrame };
    const visibleSegments = keptSegments(transcript, deleted, 30, 0, {
      ...itemEditOpts(slipped),
      window: itemWindow(slipped),
    });
    assert.ok(visibleSegments.length > 0, 'maximum left/right slip still renders kept transcript audio');
  }
}

{
  const candidate = transcriptItem(1, { deletedWordIdx: [0, 1, 2] });
  const state = stateOf(candidate);
  assert.equal(editedStreamFrames(transcript, new Set(candidate.deletedWordIdx), 30, itemEditOpts(candidate)), 0);
  const unavailable = planSlip(state, candidate.id, 10);
  assert.deepEqual(
    { ok: unavailable.ok, code: unavailable.ok ? null : unavailable.code },
    { ok: false, code: 'no-source-handles' },
  );
  assert.strictEqual(
    reduce(state, { type: 'slip', id: candidate.id, deltaInFrames: 10 }),
    state,
    'an unusable word stream leaves the original item and timeline state untouched',
  );
}

{
  for (const kind of ['image', 'text', 'motion-graphic', 'solid', 'gif', 'svg', 'sequence'] as const) {
    const unsupportedItem = item(1, { kind });
    const unsupported = planSlip(stateOf(unsupportedItem), unsupportedItem.id, 1);
    assert.deepEqual(
      { ok: unsupported.ok, code: unsupported.ok ? null : unsupported.code },
      { ok: false, code: 'unsupported-kind' },
    );
  }
  const unknown = planSlip(stateOf(item(1)), 'missing', 1);
  assert.deepEqual(
    { ok: unknown.ok, code: unknown.ok ? null : unknown.code },
    { ok: false, code: 'unknown-item' },
  );
}
{
  const fullSource = item(1, { srcInFrame: 0, durationInFrames: asset.durationInFrames });
  const unavailable = planSlip(stateOf(fullSource), fullSource.id, 1);
  assert.deepEqual(
    { ok: unavailable.ok, code: unavailable.ok ? null : unavailable.code },
    { ok: false, code: 'no-source-handles' },
  );
}


{
  const state = stateOf(item(1));
  const preview = slipPreview(state, 'clip-a', 999);
  assert.ok(preview);
  assert.equal(preview?.sourceInFrame, 240);
  assert.equal(preview?.sourceOutFrame, 299, 'two-up out point is the last visible source frame, not the exclusive window end');
  assert.equal(state.items[0]!.srcInFrame, 30, 'preview is mutation-free, so cancel restores the original source window');
  const committed = reduce(state, { type: 'slip', id: 'clip-a', deltaInFrames: 999 });
  assert.equal(committed.items[0]!.srcInFrame, preview?.plan.srcInFrame, 'preview and commit use the same planner');
  const committedPlan = planSlip(committed, 'clip-a', 0);
  assert.equal(committedPlan.ok, true);
  if (committedPlan.ok) assert.deepEqual(preview?.plan.sourceWindow, committedPlan.sourceWindow);
}

{
  const timelineState = stateOf(item(0.5));
  const { assets: _derived, ...persisted } = timelineState;
  const timeline: Timeline = { ...persisted, id: 'timeline-a', name: 'Main', order: 0 };
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [asset],
    mediaFolders: [],
    timelines: [timeline],
    activeTimelineId: timeline.id,
  };
  const initial: History = { past: [], present: doc, future: [] };
  const slipped = historyReduce(initial, { type: 'slip', id: 'clip-a', deltaInFrames: 20 });
  assert.equal(slipped.past.length, 1, 'one slip commit creates one undo step');
  assert.equal(slipped.present.timelines[0]!.items[0]!.srcInFrame, 40);
  const undone = historyReduce(slipped, { type: 'undo' });
  assert.equal(undone.present.timelines[0]!.items[0]!.srcInFrame, 30, 'undo restores the pre-slip source window');
  assert.equal(undone.present.timelines[0]!.items[0]!.startFrame, 100);
  assert.equal(undone.present.timelines[0]!.items[0]!.durationInFrames, 60);
}

console.log('slip.verify: media rates, edited transcript stream bounds, source-only placement, cancel preview, and single-step undo ok');
