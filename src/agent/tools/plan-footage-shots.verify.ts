import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { activeEditorState, type ProjectDoc } from '../../editor/types.ts';
import { execTranscriptTool, TRANSCRIPT_TOOL_SCHEMAS } from './transcript-tools.ts';

type Shot = {
  index: number; startFrame: number; endFrameExclusive: number; durationInFrames: number;
  startSeconds: number; durationSeconds: number; text: string; wordCount: number; itemId: string;
};
type PlanResult = { ok: boolean; track: string; fps: number; maxSeconds: number; totalDurationInFrames: number; shotCount: number; shots: Shot[] };

// plan_footage_shots must: tile the VO with NO gap/overlap, keep every shot ≤ maxSeconds,
// map words to GLOBAL timeline frames across back-to-back VO clips, and merge a tiny tail shot.
// Note: shots pack across VO-CLIP boundaries (a shot may span two scenes) — that is intended.

const schema = TRANSCRIPT_TOOL_SCHEMAS.find((t) => t.name === 'plan_footage_shots')!;
assert(schema, 'plan_footage_shots schema registered');
const props = schema.input_schema.properties as Record<string, unknown>;
assert(props.track && props.maxSeconds && props.minSeconds, 'exposes track/maxSeconds/minSeconds');

const fps = 30;
const clipOneWords = Array.from({ length: 12 }, (_, k) => ({ text: `w${k}`, start: k * 500, end: k * 500 + 500 })); // 6s contiguous
const clipTwoWords = Array.from({ length: 12 }, (_, k) => ({ text: `x${k}`, start: k * 500, end: k * 500 + 500 })); // 6s contiguous, placed at frame 180

const baseDoc: ProjectDoc = {
  version: 3, assets: [], mediaFolders: [], activeTimelineId: 'tl',
  timelines: [{
    id: 'tl', name: 'Main', order: 0, fps, width: 1920, height: 1080,
    trackOrder: ['audio_main'], tracks: { audio_main: { kind: 'audio' } }, selectedId: null,
    items: [
      { id: 'clip_one', track: 'audio_main', startFrame: 0, durationInFrames: 180, kind: 'audio', name: 'One', src: '/one.wav', transcript: clipOneWords },
      { id: 'clip_two', track: 'audio_main', startFrame: 180, durationInFrames: 180, kind: 'audio', name: 'Two', src: '/two.wav', transcript: clipTwoWords },
    ],
  }],
};

const ctx = {
  commands: {} as unknown as EditorCommands, // plan_footage_shots is read-only — no dispatch
  getState: () => activeEditorState(baseDoc),
  getDoc: () => baseDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
} satisfies AgentContext;

const r = await execTranscriptTool('plan_footage_shots', { track: 'A1', maxSeconds: 6 }, ctx) as PlanResult;
assert.equal(r.ok, true);
assert.equal(r.track, 'A1');
assert.equal(r.maxSeconds, 6);
assert.equal(r.shotCount, 2, '12s VO at 6s/shot → 2 shots');
assert.equal(r.totalDurationInFrames, 360, 'covers clip_one(0..180)+clip_two(180..360)');

const s = r.shots;
assert.equal(s[0]!.startFrame, 0);
assert.equal(s[0]!.endFrameExclusive, 180);
assert.equal(s[0]!.durationInFrames, 180);
assert.equal(s[0]!.wordCount, 12);
assert.equal(s[0]!.itemId, 'clip_one');
assert.equal(s[1]!.startFrame, 180, 'shot1 tiles shot0 (no gap/overlap)');
assert.equal(s[1]!.endFrameExclusive, 360);
assert.equal(s[1]!.durationInFrames, 180);
assert.equal(s[1]!.itemId, 'clip_two', 'clip_two words offset GLOBALLY by its startFrame 180');
assert.ok(String(s[0]!.text).includes('w0') && String(s[0]!.text).includes('w11'), 'text carries the spoken words');

// invariants: ≤ maxFrames, ≥1 frame, perfectly contiguous
for (let k = 0; k < s.length; k++) {
  const shot = s[k]!;
  assert.ok(shot.durationInFrames <= 180, `shot ${k} exceeds maxSeconds`);
  assert.ok(shot.durationInFrames >= 1, `shot ${k} has no duration`);
  if (k > 0) assert.equal(shot.startFrame, s[k - 1]!.endFrameExclusive, `gap or overlap at shot ${k}`);
}

// larger maxSeconds packs fewer shots
const r12 = await execTranscriptTool('plan_footage_shots', { track: 'A1', maxSeconds: 12 }, ctx) as PlanResult;
assert.ok((r12.shotCount as number) < (r.shotCount as number), '12s slots pack into fewer shots than 6s');

// tail-merge: a 1-word clip after a full shot forms a <minSeconds shot that merges into the previous.
const tailDoc: ProjectDoc = {
  ...baseDoc,
  timelines: [{
    ...baseDoc.timelines[0]!,
    items: [
      ...baseDoc.timelines[0]!.items,
      { id: 'clip_three', track: 'audio_main', startFrame: 360, durationInFrames: 6, kind: 'audio', name: 'Three', src: '/three.wav', transcript: [{ text: 'End.', start: 0, end: 200 }] },
    ],
  }],
};
const tailCtx = { ...ctx, getState: () => activeEditorState(tailDoc) } satisfies AgentContext;
const rt = await execTranscriptTool('plan_footage_shots', { track: 'A1', maxSeconds: 6 }, tailCtx) as PlanResult;
assert.equal(rt.shotCount, 2, 'tiny tail shot merged into the previous (not a 3rd shot)');
assert.equal(rt.shots[1]!.endFrameExclusive, 366, 'merged shot now spans the tail');
assert.ok(String(rt.shots[1]!.text).includes('End.'), 'merged tail text appended');

// pause-gap regression (M1): a silence between words must NOT create a black gap — the shot
// extends across the pause so consecutive shots still tile perfectly.
const gapWords = [
  ...Array.from({ length: 11 }, (_, k) => ({ text: `p${k}`, start: k * 500, end: k * 500 + 500 })), // contiguous to frame 165
  { text: 'next', start: 7000, end: 7500 }, // 1.5s pause before it → frame 210
  { text: 'more', start: 7500, end: 8000 }, // frame 225→240
  { text: 'more2', start: 8000, end: 8500 }, // frame 240→255
  { text: 'last', start: 8500, end: 9000 }, // frame 255→270 (≥minSeconds so shot1 isn't merged)
];
const gapDoc: ProjectDoc = {
  ...baseDoc,
  timelines: [{ ...baseDoc.timelines[0]!, items: [{ id: 'gap_clip', track: 'audio_main', startFrame: 0, durationInFrames: 270, kind: 'audio', name: 'Gap', src: '/gap.wav', transcript: gapWords }] }],
};
const gapCtx = { ...ctx, getState: () => activeEditorState(gapDoc) } satisfies AgentContext;
const rg = await execTranscriptTool('plan_footage_shots', { track: 'A1', maxSeconds: 6 }, gapCtx) as PlanResult;
assert.equal(rg.shotCount, 2);
assert.equal(rg.totalDurationInFrames, 270);
assert.equal(rg.shots[0]!.endFrameExclusive, 210, 'shot0 extends across the pause (no clamp → no gap)');
assert.equal(rg.shots[1]!.startFrame, 210, 'shot1 tiles shot0 — NO gap across the silence');
for (let k = 1; k < rg.shots.length; k++) {
  assert.equal(rg.shots[k]!.startFrame, rg.shots[k - 1]!.endFrameExclusive, `gap-regression: contiguous at shot ${k}`);
}

// error: track with no transcript
const emptyDoc: ProjectDoc = { ...baseDoc, timelines: [{ ...baseDoc.timelines[0]!, items: [] }] };
const emptyCtx = { ...ctx, getState: () => activeEditorState(emptyDoc) } satisfies AgentContext;
const err = await execTranscriptTool('plan_footage_shots', { track: 'A1' }, emptyCtx) as Record<string, unknown>;
assert.equal(err.ok, undefined);
assert.match(String(err.error), /transcribe_track first/);

console.log('plan-footage-shots.verify: ok (tiling/no-gap/global-offset/tail-merge/pause-gap/error)');
