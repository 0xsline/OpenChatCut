import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import { historyReduce, type AtomicAction, type History } from '../../editor/reduce.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { activeEditorState, activeTimeline, type ProjectDoc } from '../../editor/types.ts';
import { buildSilenceGapCaps, parseCleanOnly, parseSilenceRule } from '../../transcript/clean.ts';
import { execTranscriptTool, TRANSCRIPT_TOOL_SCHEMAS } from './transcript-tools.ts';

const words = [
  { text: 'um', start: 0, end: 100 },
  { text: 'hello', start: 500, end: 700 },
  { text: 'world', start: 2000, end: 2200 },
];

assert.deepEqual(parseSilenceRule('compress:400'), { mode: 'compress', maxMs: 400 });
assert.deepEqual(parseSilenceRule('max:400'), { mode: 'compress', maxMs: 400 });
assert.deepEqual(parseSilenceRule('min:500'), { mode: 'restore', minMs: 500 });
assert.deepEqual(parseSilenceRule('500'), { mode: 'normalize', targetMs: 500 });
assert.deepEqual(parseSilenceRule('min:300,max:800'), { mode: 'range', minMs: 300, maxMs: 800 });
assert.deepEqual(parseCleanOnly('silence'), { fillers: false, silence: true });
assert.throws(() => parseSilenceRule('range:900-200'), /minimum cannot exceed/);

const compressed = buildSilenceGapCaps(words, { mode: 'compress', maxMs: 400 }, { fps: 30 });
assert.deepEqual(compressed, { '2': 400 });
const restored = buildSilenceGapCaps(words, { mode: 'restore', minMs: 500 }, {
  fps: 30,
  silenceFrames: 6,
});
assert.deepEqual(restored, { '1': 400, '2': 500 }, 'restore cannot exceed the original pause');
const ranged = buildSilenceGapCaps(words, { mode: 'range', minMs: 300, maxMs: 800 }, { fps: 30 });
assert.deepEqual(ranged, { '2': 800 });

const initial: ProjectDoc = {
  version: 3,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline_main',
  timelines: [{
    id: 'timeline_main', name: 'Main', order: 0, fps: 30, width: 1920, height: 1080,
    trackOrder: ['audio_main'], tracks: { audio_main: { kind: 'audio' } }, selectedId: null,
    items: [
      { id: 'clip_one', track: 'audio_main', startFrame: 0, durationInFrames: 90, kind: 'audio', name: 'One', src: '/one.wav', transcript: words },
      { id: 'clip_two', track: 'audio_main', startFrame: 100, durationInFrames: 90, kind: 'audio', name: 'Two', src: '/two.wav', transcript: words },
    ],
  }],
};

let history: History = { past: [], present: structuredClone(initial), future: [] };
const commands = {
  batch: (actions: AtomicAction[], label?: string) => {
    history = historyReduce(history, { type: 'batch', actions, label });
  },
} as EditorCommands;
const ctx = {
  commands,
  getState: () => activeEditorState(history.present),
  getDoc: () => history.present,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
} satisfies AgentContext;

const schema = TRANSCRIPT_TOOL_SCHEMAS.find((tool) => tool.name === 'clean_script')!;
const properties = schema.input_schema.properties as Record<string, unknown>;
assert(properties.only);
assert(properties.silence);
assert(properties.longSilence);

const result = await execTranscriptTool('clean_script', {
  track: 'A1',
  only: 'silence',
  silence: 'normalize:500',
}, ctx) as Record<string, unknown>;
assert.equal(result.ok, true);
assert.equal(history.past.length, 1, 'whole-track cleanup must be one undo step');
for (const clip of activeTimeline(history.present).items) {
  assert.deepEqual(clip.gapCapsMs, { '2': 500 });
  assert.deepEqual(clip.deletedWordIdx, []);
}

history = historyReduce(history, { type: 'undo' });
assert.deepEqual(history.present, initial, 'one undo restores every cleaned clip');

const legacy = await execTranscriptTool('clean_script', { track: 'A1' }, ctx) as Record<string, unknown>;
assert.equal(legacy.ok, true);
assert.deepEqual(activeTimeline(history.present).items[0]?.deletedWordIdx, [0], 'legacy default still removes fillers');
assert.equal(activeTimeline(history.present).items[0]?.silenceFrames, undefined, 'legacy default still leaves pauses uncapped');

console.log('clean-script rule checks passed');
