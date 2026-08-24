import assert from 'node:assert/strict';
import type { TimelineState, MediaAsset } from '../../editor/types';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import { validateGenericAdd } from './edit-item-generic';

const state = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  tracks: { 'trk-v1': { kind: 'video' }, 'trk-a1': { kind: 'audio' } },
  transitions: [],
} as unknown as TimelineState;

const assets = [
  { id: 'asset-v', name: '素材.mp4', kind: 'video', src: '/media/uploads/v.mp4', durationInFrames: 900, width: 1920, height: 1080 },
  { id: 'asset-a', name: '音乐.mp3', kind: 'audio', src: '/media/uploads/m.mp3', durationInFrames: 6000 },
  {
    id: 'asset-at',
    name: '访谈.mp3',
    kind: 'audio',
    src: '/media/uploads/interview.mp3',
    durationInFrames: 6000,
    transcript: [
      { text: 'first', start: 2_000, end: 3_000 },
      { text: 'second', start: 4_000, end: 5_000 },
    ],
  },
  { id: 'asset-g', name: '动图.gif', kind: 'gif', src: '/media/uploads/a.gif', durationInFrames: 300, width: 640, height: 360 },
] as MediaAsset[];

async function main(): Promise<void> {
  const hit = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceStartMs: 12_500,
    sourceEndMs: 13_800,
    track: 'V1',
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.plan, 'addMedia');
  assert.equal(hit.srcInFrame, Math.round(12.5 * 30), 'millisecond hit converts to srcInFrame');
  assert.equal(hit.durationInFrames, Math.round((13.8 - 12.5) * 30), 'millisecond window converts to frames');

  const seconds = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceStartSeconds: 12.5,
    sourceEndSeconds: 13.8,
  });
  assert.equal(seconds.srcInFrame, hit.srcInFrame, 'explicit seconds remain supported');
  assert.equal(seconds.durationInFrames, hit.durationInFrames);

  const exactFrames = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceStartFrame: 123,
    sourceDurationInFrames: 77,
  });
  assert.equal(exactFrames.ok, true);
  assert.equal(exactFrames.srcInFrame, 123);
  assert.equal(exactFrames.durationInFrames, 77);
  assert.deepEqual(exactFrames.sourceRange, {
    startFrame: 123, durationInFrames: 77, endFrameExclusive: 200,
  });

  const openEnd = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceStartSeconds: 20,
  });
  assert.equal(openEnd.ok, true);
  assert.equal(openEnd.srcInFrame, 600);
  assert.equal(openEnd.durationInFrames, 300, 'open end runs to the asset end');

  const openStart = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceEndSeconds: 3,
  });
  assert.equal(openStart.ok, true);
  assert.equal(openStart.srcInFrame, 0);
  assert.equal(openStart.durationInFrames, 90);

  for (const invalid of [
    { sourceStartSeconds: -1, sourceEndSeconds: 2 },
    { sourceStartSeconds: 5, sourceEndSeconds: 5 },
    { sourceStartSeconds: 5, sourceEndSeconds: 4 },
    { sourceStartMs: 1_000, sourceStartSeconds: 1, sourceEndMs: 2_000 },
    { sourceStartFrame: 10, sourceDurationInFrames: 0 },
    { sourceStartFrame: 895, sourceDurationInFrames: 10 },
    { sourceStartFrame: 10, sourceDurationInFrames: 5, sourceStartSeconds: 1 },
  ]) {
    const result = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v', ...invalid });
    assert.ok('error' in result, `invalid source window must fail: ${JSON.stringify(invalid)}`);
  }

  const conflict = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceStartSeconds: 1,
    sourceEndSeconds: 3,
    durationInFrames: 60,
  });
  assert.match(String(conflict.error), /do not combine/);

  const overEnd = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceStartSeconds: 40,
  });
  assert.match(String(overEnd.error), /past the end/);
  const endPast = validateGenericAdd(state, assets, {
    type: 'video',
    assetId: 'asset-v',
    sourceEndSeconds: 99,
  });
  assert.match(String(endPast.error), /exceeds the asset length/);

  const audioHit = validateGenericAdd(state, assets, {
    type: 'audio',
    assetId: 'asset-a',
    sourceStartSeconds: 5,
    sourceEndSeconds: 9,
  });
  assert.equal(audioHit.srcInFrame, 150);
  assert.equal(audioHit.durationInFrames, 120);
  const transcriptAudioWindow = validateGenericAdd(state, assets, {
    type: 'audio',
    assetId: 'asset-at',
    sourceStartSeconds: 3,
    sourceEndSeconds: 4,
  });
  assert.match(
    String(transcriptAudioWindow.error),
    /operational transcript.*packed edited stream/,
    'raw-source timestamps must not be mistaken for edited-stream frames',
  );
  assert.equal('srcInFrame' in transcriptAudioWindow, false, 'rejected audio window must not expose a committable trim');

  const gifWindow = validateGenericAdd(state, assets, {
    type: 'gif',
    assetId: 'asset-g',
    sourceStartMs: 1_000,
    sourceEndMs: 2_000,
  });
  assert.match(String(gifWindow.error), /GIF source windows are unsupported.*does not consume srcInFrame/);
  assert.equal('srcInFrame' in gifWindow, false, 'rejected GIF window must not expose a committable trim');


  const kindMismatch = validateGenericAdd(state, assets, {
    type: 'audio',
    assetId: 'asset-v',
  });
  assert.ok('error' in kindMismatch, 'kind mismatch stays rejected');

  const plain = validateGenericAdd(state, assets, { type: 'video', assetId: 'asset-v' });
  assert.equal(plain.ok, true);
  assert.equal('srcInFrame' in plain, false);
  assert.equal('durationInFrames' in plain, false);

  const draft = makeDraft(docFromTimeline({ ...state, assets } as unknown as TimelineState));
  const itemId = draft.commands.addMediaItem(assets[0]!, {
    track: String(hit.track),
    srcInFrame: Number(hit.srcInFrame),
    startFrame: Number(hit.startFrame ?? 0),
  });
  const placed = draft.getState().items.find((item) => item.id === itemId);
  assert.equal(placed?.srcInFrame, Math.round(12.5 * 30), 'EditorCommands preserves the source in-point');

  console.log('edit-item-source-range.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
