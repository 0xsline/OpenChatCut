import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import { makeDraft } from '../../editor/store';
import { trackAlias, type ProjectDoc, type Timeline } from '../../editor/types';
import { applyScript } from '../../script/apply';
import { serializeTimeline } from '../../script/serialize';
import { execScriptTool, SCRIPT_TOOL_SCHEMAS } from './script-tools';

const timeline: Timeline = {
  id: 'timeline_1',
  name: 'Timeline',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['track_v1', 'track_v2'],
  tracks: {
    track_v1: { kind: 'video' },
    track_v2: { kind: 'video' },
  },
  items: [
    {
      id: 'speech',
      track: 'track_v1',
      startFrame: 0,
      durationInFrames: 39,
      kind: 'video',
      name: 'Speech.mp4',
      src: '/media/speech.mp4',
      transcript: [
        { text: 'Hello', start: 0, end: 300 },
        { text: 'world.', start: 1000, end: 1300 },
      ],
    },
    {
      id: 'visual',
      track: 'track_v2',
      startFrame: 12,
      durationInFrames: 20,
      kind: 'video',
      name: 'Visual.mp4',
      src: '/media/visual.mp4',
    },
  ],
};

const doc: ProjectDoc = {
  version: 3,
  assets: [],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
const speechAlias = trackAlias(timeline, 'track_v1');
const visualAlias = trackAlias(timeline, 'track_v2');

const defaultRead = serializeTimeline(timeline);
assert.match(defaultRead.md, new RegExp(`## ${speechAlias}`));
assert.match(defaultRead.md, new RegExp(`## ${visualAlias}`));
assert.doesNotMatch(defaultRead.md, /script-track:/);
assert.doesNotMatch(defaultRead.md, /\[silence=/);

const scopedRead = serializeTimeline(timeline, { trackId: 'track_v1', showSilence: true });
assert.match(scopedRead.md, /script-track:track_v1/);
assert.match(scopedRead.md, /script-silence:true/);
assert.match(scopedRead.md, /\[silence=0\.7s\]/);
assert.ok(
  scopedRead.md.indexOf('[silence=0.7s]') < scopedRead.md.indexOf('[s1] Hello world.'),
  'a silence marker must appear before the segment that starts after the pause',
);
assert.match(scopedRead.md, new RegExp(`## ${speechAlias}`));
assert.doesNotMatch(scopedRead.md, new RegExp(`## ${visualAlias}`));

const draft = makeDraft(doc);
const compressed = scopedRead.md.replace('[silence=0.7s]', '[silence=0.7s→0.2s]');
applyScript(draft.getState, draft.commands, compressed, { trackId: 'track_v1' });
assert.equal(draft.getState().items.find((item) => item.id === 'speech')?.gapCapsMs?.['1'], 200);
assert.deepEqual(
  draft.getState().items.find((item) => item.id === 'visual'),
  timeline.items.find((item) => item.id === 'visual'),
);

const afterCompression = serializeTimeline(draft.getState(), { trackId: 'track_v1' });
const deleteWord = afterCompression.md.replace('[s1] Hello world.', '[s1] ~~Hello~~ world.');
applyScript(draft.getState, draft.commands, deleteWord, { trackId: 'track_v1' });
assert.deepEqual(draft.getState().items.find((item) => item.id === 'speech')?.deletedWordIdx, [0]);
assert.equal(draft.getState().items.find((item) => item.id === 'visual')?.startFrame, 12);

const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};
assert.deepEqual(await execScriptTool('read_script', { track: 'missing' }, ctx), { error: '轨道「missing」不存在' });
const toolRead = await execScriptTool('read_script', { track: speechAlias, showSilence: true }, ctx) as { content: string; trackId: string };
assert.equal(toolRead.trackId, 'track_v1');
assert.match(toolRead.content, /script-silence:true/);

const readSchema = SCRIPT_TOOL_SCHEMAS.find((tool) => tool.name === 'read_script')!;
const applySchema = SCRIPT_TOOL_SCHEMAS.find((tool) => tool.name === 'apply_script')!;
assert('track' in (readSchema.input_schema.properties ?? {}));
assert('showSilence' in (readSchema.input_schema.properties ?? {}));
assert('track' in (applySchema.input_schema.properties ?? {}));

console.log('script tools check passed');
