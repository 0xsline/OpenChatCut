import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { migrateProjectDoc } from '../persist/projectStore';
import { historyReduce, reduce } from './reduce';
import { setLinkGroup, unlinkItems } from './linkGroups';
import { sourceClockOffsetInTimelineFrames, sourceClockToTimelineFrame } from './timecode';
import type { ProjectDoc, SourceClockMetadata, Timeline, TimelineItem, TimelineState } from './types';

const clip = (
  id: string,
  track: string,
  startFrame: number,
  kind: 'video' | 'audio' = 'video',
  playbackRate = 1,
): TimelineItem => ({
  id,
  track,
  startFrame,
  durationInFrames: 100,
  name: id,
  kind,
  src: `/media/${id}.mov`,
  srcInFrame: 0,
  playbackRate,
});

const state = (items: TimelineItem[]): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items,
  trackOrder: ['v', 'a', 'v-next', 'a-next'],
  tracks: {
    v: { kind: 'video' },
    a: { kind: 'audio' },
    'v-next': { kind: 'video' },
    'a-next': { kind: 'audio' },
  },
  selectedId: null,
  selectedIds: [],
});

// Exact clocks align across different source frame rates without treating display labels as seconds.
{
  const reference: SourceClockMetadata = {
    frameCount: 86_400,
    frameRate: { numerator: 24, denominator: 1 },
    dropFrame: false,
  };
  const follower: SourceClockMetadata = {
    frameCount: 108_000,
    frameRate: { numerator: 30_000, denominator: 1_001 },
    dropFrame: true,
  };
  assert.equal(sourceClockToTimelineFrame(reference, 30), 108_000);
  assert.equal(sourceClockOffsetInTimelineFrames(reference, follower, 30), 108);
}

// Linked A/V move and left trim preserve the same timeline offset while converting source deltas per rate.
{
  const video = clip('video', 'v', 20, 'video', 1);
  const audio = clip('audio', 'a', 20, 'audio', 2);
  const linked: TimelineState = {
    ...state([video, audio]),
    linkGroups: [{ id: 'av', itemIds: ['video', 'audio'], anchorItemId: 'video', mode: 'linked' }],
  };
  const moved = reduce(linked, { type: 'move', id: 'video', startFrame: 50 });
  assert.equal(moved.items.find((item) => item.id === 'video')?.startFrame, 50);
  assert.equal(moved.items.find((item) => item.id === 'audio')?.startFrame, 50);

  const trimmed = reduce(moved, {
    type: 'retime',
    id: 'video',
    startFrame: 60,
    durationInFrames: 90,
    srcInFrame: 10,
  });
  const trimmedAudio = trimmed.items.find((item) => item.id === 'audio')!;
  assert.equal(trimmedAudio.startFrame, 60);
  assert.equal(trimmedAudio.durationInFrames, 90);
  assert.equal(trimmedAudio.srcInFrame, 20, '10 timeline frames become 20 source frames at 2x');

  const removed = reduce(trimmed, { type: 'remove', id: 'video' });
  assert.deepEqual(removed.items, []);
  assert.equal(removed.linkGroups, undefined);
}

// Link and unlink each enter project history as exactly one state transaction.
{
  const base = state([clip('history-v', 'v', 0), clip('history-a', 'a', 0, 'audio')]);
  const timeline: Timeline = { ...base, id: 'history', name: 'History', order: 0 };
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    timelines: [timeline],
    activeTimelineId: timeline.id,
  };
  let history = { past: [] as ProjectDoc[], present: doc, future: [] as ProjectDoc[] };
  const linked = setLinkGroup(timeline, {
    id: 'history-link',
    itemIds: ['history-v', 'history-a'],
    anchorItemId: 'history-v',
    mode: 'linked',
  });
  history = historyReduce(history, { type: 'setFullState', state: linked });
  assert.equal(history.past.length, 1);
  history = historyReduce(history, {
    type: 'setFullState',
    state: unlinkItems(history.present.timelines[0]!, ['history-v', 'history-a']),
  });
  assert.equal(history.past.length, 2);
}

// A ripple on one lane propagates through a sync-lock group on another lane.
{
  const cut = { ...clip('cut', 'v', 0), durationInFrames: 10 };
  const videoFollower = { ...clip('video-next', 'v', 10), durationInFrames: 20 };
  const audioFollower = { ...clip('audio-next', 'a-next', 50, 'audio'), durationInFrames: 20 };
  const locked: TimelineState = {
    ...state([cut, videoFollower, audioFollower]),
    linkGroups: [{
      id: 'sync',
      itemIds: ['video-next', 'audio-next'],
      anchorItemId: 'video-next',
      mode: 'sync-lock',
    }],
  };
  const next = reduce(locked, { type: 'remove', id: 'cut', ripple: true });
  assert.equal(next.items.find((item) => item.id === 'video-next')?.startFrame, 0);
  assert.equal(next.items.find((item) => item.id === 'audio-next')?.startFrame, 40);
}

// Removing one sync-lock member repairs membership and anchor instead of leaving a dangling group.
{
  const members = [
    clip('sync-a', 'v', 0),
    clip('sync-b', 'a', 0, 'audio'),
    clip('sync-c', 'a-next', 0, 'audio'),
  ];
  const grouped: TimelineState = {
    ...state(members),
    linkGroups: [{
      id: 'sync-membership',
      itemIds: members.map((item) => item.id),
      anchorItemId: 'sync-a',
      mode: 'sync-lock',
    }],
  };
  const next = reduce(grouped, { type: 'remove', id: 'sync-a' });
  assert.deepEqual(next.linkGroups?.[0]?.itemIds, ['sync-b', 'sync-c']);
  assert.equal(next.linkGroups?.[0]?.anchorItemId, 'sync-b');
}

// Professional metadata round-trips, while a current-version legacy doc stays field-absent.
{
  const reference = clip('cam-a', 'V1', 0);
  const follower = clip('cam-b', 'V2', 0);
  const timeline: Timeline = {
    ...state([reference, follower]),
    id: 'timeline',
    name: 'Timeline',
    order: 0,
    linkGroups: [{ id: 'av', itemIds: ['cam-a', 'cam-b'], anchorItemId: 'cam-a', mode: 'sync-lock' }],
    multicamGroups: [{
      id: 'multicam',
      referenceAngleId: 'angle-a',
      masterAngleId: 'angle-a',
      syncMethod: 'source-timecode',
      angles: [
        { id: 'angle-a', itemId: 'cam-a', source: reference, label: 'A', offsetFrames: 0, confidence: 1 },
        { id: 'angle-b', itemId: 'cam-b', source: follower, label: 'B', offsetFrames: 12, confidence: 1 },
      ],
      evidence: [
        { angleId: 'angle-a', method: 'source-timecode', confidence: 1, offsetFrames: 0 },
        { angleId: 'angle-b', method: 'source-timecode', confidence: 1, offsetFrames: 12 },
      ],
    }],
  };
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [{
      id: 'asset-a', name: 'A', kind: 'video', src: reference.src!, durationInFrames: 100,
      sourceTimecode: { frameCount: 100, frameRate: { numerator: 24, denominator: 1 }, dropFrame: false },
    }],
    mediaFolders: [],
    timelines: [timeline],
    activeTimelineId: timeline.id,
  };
  const reopened = migrateProjectDoc(JSON.parse(JSON.stringify(doc)))!;
  assert.equal(reopened.assets[0]?.sourceTimecode?.frameRate.numerator, 24);
  assert.equal(reopened.timelines[0]?.linkGroups?.[0]?.anchorItemId, 'cam-a');
  assert.equal(reopened.timelines[0]?.multicamGroups?.[0]?.evidence[1]?.offsetFrames, 12);

  const legacyTimeline = { ...timeline };
  delete legacyTimeline.linkGroups;
  delete legacyTimeline.multicamGroups;
  const legacy = migrateProjectDoc({ ...doc, timelines: [legacyTimeline], assets: [] })!;
  assert.equal(Object.hasOwn(legacy.timelines[0]!, 'linkGroups'), false);
  assert.equal(Object.hasOwn(legacy.timelines[0]!, 'multicamGroups'), false);
}

console.log('professionalTimeline.verify: ok (timecode + linked/sync-lock edits + migration roundtrip)');
