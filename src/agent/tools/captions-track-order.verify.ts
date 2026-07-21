import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import { makeDraft } from '../../editor/store';
import type { CaptionSourceEntry, CaptionsData } from '../../captions/types';
import { buildLaneGroups } from '../../captions/lanes';
import { normalizeCaptionSourceEntries, orderedCaptionSourceEntries } from '../../captions/sourceOrder';
import { migrateProjectDoc } from '../../persist/projectStore';
import { trackAlias, type ProjectDoc, type Timeline, type TimelineItem } from '../../editor/types';
import { CAPTIONS_TOOL_SCHEMAS, execCaptionsTool } from './captions-tools';

const word = (text: string) => [{ text, start: 0, end: 800 }];
const item = (id: string, track: string, text: string): TimelineItem => ({
  id,
  track,
  startFrame: 0,
  durationInFrames: 30,
  kind: 'audio',
  name: `${text}.wav`,
  src: `/media/${text}.wav`,
  transcript: word(text),
});

const legacyEntries: CaptionSourceEntry[] = [
  { id: 'source_a', itemId: 'item_a' },
  { id: 'source_b', itemId: 'item_b' },
  { id: 'source_c', itemId: 'item_c' },
];
assert.deepEqual(orderedCaptionSourceEntries(legacyEntries).map((entry) => entry.id), ['source_a', 'source_b', 'source_c']);
assert.deepEqual(
  normalizeCaptionSourceEntries([
    { ...legacyEntries[0], trackOrder: 1 },
    { ...legacyEntries[1], trackOrder: 1 },
    { ...legacyEntries[2], trackOrder: 0 },
  ]).map((entry) => [entry.id, entry.trackOrder]),
  [['source_c', 0], ['source_a', 1], ['source_b', 2]],
  'duplicate trackOrder values normalize stably to contiguous positions',
);

const captions: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  sourceEntries: legacyEntries,
  sourceMode: 'item',
};
const timeline: Timeline = {
  id: 'timeline_1',
  name: 'Timeline',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['track_a', 'track_b', 'track_c'],
  tracks: {
    track_a: { kind: 'audio' },
    track_b: { kind: 'audio' },
    track_c: { kind: 'audio' },
  },
  items: [item('item_a', 'track_a', 'A'), item('item_b', 'track_b', 'B'), item('item_c', 'track_c', 'C')],
  captions,
};
const doc: ProjectDoc = {
  version: 2,
  assets: [],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
const draft = makeDraft(doc);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const moved = await execCaptionsTool('edit_captions', {
  action: 'source_update',
  json: { updates: [{ sourceId: 'source_c', trackOrder: 0 }] },
}, ctx) as { ok: boolean; updated: Array<{ sourceId: string; trackOrder: number }> };
assert.equal(moved.ok, true);
assert.deepEqual(moved.updated.map((entry) => [entry.sourceId, entry.trackOrder]), [
  ['source_c', 0], ['source_a', 1], ['source_b', 2],
]);
assert.deepEqual(draft.getState().captions?.sourceEntries?.map((entry) => [entry.id, entry.trackOrder]), [
  ['source_c', 0], ['source_a', 1], ['source_b', 2],
]);

const read = await execCaptionsTool('read_captions', {}, ctx) as {
  sources: Array<{ sourceId: string; trackOrder: number }>;
};
assert.deepEqual(read.sources.map((entry) => [entry.sourceId, entry.trackOrder]), [
  ['source_c', 0], ['source_a', 1], ['source_b', 2],
]);

const groups = buildLaneGroups(draft.getState().captions!, draft.getState().items, 30, 100, 6);
assert.deepEqual(groups?.[0]?.lanes.map((lane) => lane.entry.id), ['source_c', 'source_a', 'source_b']);

const reopened = migrateProjectDoc(JSON.parse(JSON.stringify(draft.getDoc())));
assert.deepEqual(reopened?.timelines[0].captions?.sourceEntries?.map((entry) => [entry.id, entry.trackOrder]), [
  ['source_c', 0], ['source_a', 1], ['source_b', 2],
]);

const legacyReopened = migrateProjectDoc(JSON.parse(JSON.stringify(doc)));
assert.deepEqual(legacyReopened?.timelines[0].captions?.sourceEntries?.map((entry) => entry.id), [
  'source_a', 'source_b', 'source_c',
]);
const legacyGroups = buildLaneGroups(legacyReopened!.timelines[0].captions!, legacyReopened!.timelines[0].items, 30, 100, 6);
assert.deepEqual(legacyGroups?.[0]?.lanes.map((lane) => lane.entry.id), ['source_a', 'source_b', 'source_c']);

const replaced = await execCaptionsTool('edit_captions', {
  action: 'source_set',
  json: {
    sources: [
      { itemId: 'item_a', trackOrder: 1 },
      { itemId: 'item_b', trackOrder: 1 },
      { itemId: 'item_c', trackOrder: 0 },
    ],
  },
}, ctx) as { sources: Array<{ itemId: string; trackOrder: number }> };
assert.deepEqual(replaced.sources.map((entry) => [entry.itemId, entry.trackOrder]), [
  ['item_c', 0], ['item_a', 1], ['item_b', 2],
]);

const listedTracks = await execCaptionsTool('edit_captions', { action: 'track', list: true }, ctx) as {
  tracks: Array<{ trackOrder: number; trackId: string }>;
};
assert.deepEqual(listedTracks.tracks.map((track) => track.trackOrder), [0, 1, 2]);
assert.deepEqual(listedTracks.tracks.map((track) => track.trackId), [
  trackAlias(draft.getState(), 'track_a'),
  trackAlias(draft.getState(), 'track_b'),
  trackAlias(draft.getState(), 'track_c'),
]);
const selectedByOrder = await execCaptionsTool('edit_captions', { action: 'track', trackOrder: '1' }, ctx) as {
  trackOrder: number; sourceItemId: string;
};
assert.equal(selectedByOrder.trackOrder, 1);
assert.equal(selectedByOrder.sourceItemId, 'item_b');
assert.match(String((await execCaptionsTool('edit_captions', { action: 'track', trackOrder: 99 }, ctx) as { error: string }).error), /out of range/);

const schema = CAPTIONS_TOOL_SCHEMAS.find((tool) => tool.name === 'edit_captions')!;
assert('trackOrder' in (schema.input_schema.properties ?? {}));

console.log('caption track order check passed');
