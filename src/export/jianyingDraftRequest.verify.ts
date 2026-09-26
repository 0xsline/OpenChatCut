// Runnable check: `npx tsx src/export/jianyingDraftRequest.verify.ts`
// The JianYing request carries each clip's source window, flattens nested
// sequences the way the preview plays them, and the agent tool sends exactly
// what the export dialog sends (one builder).
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.js';
import type { AgentContext } from '../agent/context';
import { jianyingExportBody } from '../agent/tools/jianying-export-tool';
import type { CaptionsData } from '../captions/types';
import { isSequenceGraphError } from '../editor/sequenceGraph';
import { timelinePlacements } from '../editor/sequenceFlatten';
import type { ProjectDoc, Timeline, TimelineItem } from '../editor/types';
import { jianyingDraftPayload, type JianyingDraftClip } from './jianyingDraftRequest';

const clip = (
  id: string,
  kind: TimelineItem['kind'],
  startFrame: number,
  durationInFrames: number,
  extra: Partial<TimelineItem> = {},
): TimelineItem => ({
  id,
  kind,
  name: id,
  src: `/media/uploads/${id}.bin`,
  track: kind === 'audio' ? 'A1' : 'V1',
  startFrame,
  durationInFrames,
  ...extra,
});

const timeline = (id: string, items: TimelineItem[], extra: Partial<Timeline> = {}): Timeline => ({
  id,
  name: id,
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items,
  selectedId: null,
  ...extra,
});

const project = (timelines: Timeline[], activeTimelineId = timelines[0]!.id): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines,
  activeTimelineId,
});

// ── flat timeline: every media clip carries its source window ─────────────────
{
  const words = [
    { text: 'keep', start: 1000, end: 1500 },
    { text: 'drop', start: 1600, end: 2000 },
    { text: 'tail', start: 3000, end: 3500 },
  ];
  const flat = timeline('flat', [
    clip('trimmed', 'video', 0, 60, { srcInFrame: 900, volume: 0.5 }),
    clip('fast', 'video', 60, 30, { srcInFrame: 300, playbackRate: 2 }),
    clip('slow-from-zero', 'video', 90, 30, { playbackRate: 0.5 }),
    clip('still', 'image', 120, 15, { srcInFrame: 40, playbackRate: 3 }),
    clip('loop', 'gif', 135, 15, { srcInFrame: 12 }),
    clip('vector', 'svg', 150, 15),
    clip('title', 'text', 150, 15, { src: undefined }),
    clip('music', 'audio', 0, 90, { srcInFrame: 12 }),
    // Word-driven audio plays only its kept runs: "drop" is deleted.
    clip('voice', 'audio', 90, 30, { transcript: words, deletedWordIdx: [1] }),
  ]);
  const payload = jianyingDraftPayload(project([flat]));
  assert.equal(payload.fps, 30);
  assert.deepEqual(payload.items, [
    { kind: 'video', src: '/media/uploads/trimmed.bin', startFrame: 0, durationInFrames: 60, srcInFrame: 900, playbackRate: 1, volume: 0.5, name: 'trimmed' },
    { kind: 'audio', src: '/media/uploads/music.bin', startFrame: 0, durationInFrames: 90, srcInFrame: 12, playbackRate: 1, volume: undefined, name: 'music' },
    { kind: 'video', src: '/media/uploads/fast.bin', startFrame: 60, durationInFrames: 30, srcInFrame: 300, playbackRate: 2, volume: undefined, name: 'fast' },
    { kind: 'video', src: '/media/uploads/slow-from-zero.bin', startFrame: 90, durationInFrames: 30, srcInFrame: 0, playbackRate: 0.5, volume: undefined, name: 'slow-from-zero' },
    // keep: source frames 30–45 at timeline 90; tail: 90–105 packed right after.
    { kind: 'audio', src: '/media/uploads/voice.bin', startFrame: 90, durationInFrames: 15, srcInFrame: 30, playbackRate: 1, volume: undefined, name: 'voice' },
    { kind: 'audio', src: '/media/uploads/voice.bin', startFrame: 105, durationInFrames: 15, srcInFrame: 90, playbackRate: 1, volume: undefined, name: 'voice' },
    // Stills render through <Img>: no in-point, no speed.
    { kind: 'image', src: '/media/uploads/still.bin', startFrame: 120, durationInFrames: 15, srcInFrame: 0, playbackRate: 1, volume: undefined, name: 'still' },
    { kind: 'gif', src: '/media/uploads/loop.bin', startFrame: 135, durationInFrames: 15, srcInFrame: 0, playbackRate: 1, volume: undefined, name: 'loop' },
  ], 'svg / text are not exported; every other clip keeps its source window, in timeline order');
}

const sourceWindows = (clips: JianyingDraftClip[]) => clips.map((item) => [item.name, item.startFrame, item.durationInFrames, item.srcInFrame, item.playbackRate]);

// ── #160: a rough cut made of sequences that window one long source timeline ──
{
  const wordCaptions: CaptionsData = { enabled: true, template: 'plain', pacing: 'word', sourceItemId: 'master' };
  const source = timeline('source', [
    clip('master', 'video', 0, 9000, {
      transcript: [
        { text: 'alpha', start: 100_000, end: 100_500 },
        { text: 'beta', start: 103_500, end: 104_500 },
        { text: 'gamma', start: 200_000, end: 200_500 },
        { text: 'delta', start: 20_000, end: 21_000 },
        { text: 'unused', start: 50_000, end: 50_500 },
      ],
    }),
    clip('original-audio', 'audio', 0, 9000),
  ], { captions: wordCaptions });
  const sequence = (id: string, startFrame: number, durationInFrames: number, srcInFrame: number, playbackRate = 1): TimelineItem => (
    clip(id, 'sequence', startFrame, durationInFrames, { src: undefined, timelineId: 'source', srcInFrame, playbackRate })
  );
  const roughCut = timeline('rough-cut', [
    sequence('range-b', 120, 90, 6000),
    sequence('range-a', 0, 120, 3000),
    sequence('range-c', 210, 30, 600, 2),
  ]);
  const payload = jianyingDraftPayload(project([source, roughCut], 'rough-cut'));
  assert.deepEqual(sourceWindows(payload.items), [
    ['master', 0, 120, 3000, 1],
    ['original-audio', 0, 120, 3000, 1],
    ['master', 120, 90, 6000, 1],
    ['original-audio', 120, 90, 6000, 1],
    // 2x: 30 timeline frames play source frames 600–660.
    ['master', 210, 30, 600, 2],
    ['original-audio', 210, 30, 600, 2],
  ], 'every sequence becomes its own editable clips, in timeline order, reading its own source range');
  assert.deepEqual(payload.captions, [
    { startMs: 0, endMs: 500, text: 'alpha' },
    // beta runs past range A's end (104 s) and is cut there.
    { startMs: 3500, endMs: 4000, text: 'beta' },
    { startMs: 4000, endMs: 4500, text: 'gamma' },
    { startMs: 7000, endMs: 7500, text: 'delta' },
  ], 'child captions are clipped to each sequence window and re-timed onto the rough cut');
}

// ── windows clip leaves; rates compose through two levels of nesting ─────────
{
  const leaf = timeline('leaf', [clip('leaf-video', 'video', 0, 200, { playbackRate: 1.5 })]);
  const middle = timeline('middle', [
    clip('b-roll', 'video', 50, 100, { srcInFrame: 1000 }),
    clip('late', 'video', 180, 70, { srcInFrame: 40 }),
    clip('card', 'image', 100, 100),
    clip('to-leaf', 'sequence', 300, 80, { src: undefined, timelineId: 'leaf', srcInFrame: 20, playbackRate: 2 }),
  ]);
  const root = timeline('root', [
    clip('middle-window', 'sequence', 300, 100, { src: undefined, timelineId: 'middle', srcInFrame: 100 }),
    clip('deep', 'sequence', 500, 40, { src: undefined, timelineId: 'middle', srcInFrame: 330, playbackRate: 0.5 }),
  ]);
  const doc = project([root, middle, leaf], 'root');
  assert.deepEqual(sourceWindows(jianyingDraftPayload(doc).items), [
    // middle frames 100–200 at root 300: b-roll (50–150) loses its first 50 frames.
    ['b-roll', 300, 50, 1050, 1],
    ['card', 300, 100, 0, 1],
    ['late', 380, 20, 40, 1],
    // root 500–540 at 0.5x shows middle 330–350, which shows leaf 20 + 2·(330−300) = 80
    // onward at 2x; the leaf clip plays at 1.5x, so the root sees 0.5·2·1.5 = 1.5x from 120.
    ['leaf-video', 500, 40, 120, 1.5],
  ]);
  assert.deepEqual(timelinePlacements(doc, 'root').map((placement) => [placement.timeline.id, placement.fromFrame, placement.toFrame, placement.rootFrame, placement.rate]), [
    ['root', 0, Number.POSITIVE_INFINITY, 0, 1],
    // middle-window never reaches to-leaf (middle 300+), so only one leaf instance.
    ['middle', 100, 200, 300, 1],
    ['middle', 330, 350, 500, 0.5],
    ['leaf', 80, 120, 500, 1],
  ]);
}

// ── a broken sequence graph fails the export the way it fails a render ───────
{
  const dangling = timeline('dangling', [
    clip('shot', 'video', 0, 30),
    clip('lost', 'sequence', 30, 30, { src: undefined, timelineId: 'deleted' }),
  ]);
  assert.throws(() => jianyingDraftPayload(project([dangling])),
    (error: unknown) => isSequenceGraphError(error) && error.code === 'SEQUENCE_TIMELINE_MISSING');
  const loopA = timeline('loop-a', [clip('to-b', 'sequence', 0, 30, { src: undefined, timelineId: 'loop-b' })]);
  const loopB = timeline('loop-b', [clip('to-a', 'sequence', 0, 30, { src: undefined, timelineId: 'loop-a' })]);
  assert.throws(() => jianyingDraftPayload(project([loopA, loopB])),
    (error: unknown) => isSequenceGraphError(error) && error.code === 'SEQUENCE_CYCLE');
}

// ── captions follow the projection the preview and the .srt export use ────────
{
  const talk = clip('talk', 'video', 30, 60, {
    srcInFrame: 60,
    transcript: [
      { text: 'early', start: 500, end: 900 },
      { text: 'hello', start: 2000, end: 2400 },
      { text: 'world', start: 2500, end: 2900 },
    ],
  });
  const captioned = (enabled: boolean) => timeline('captioned', [talk], {
    captions: { enabled, template: 'plain', pacing: 'phrase', sourceItemId: 'talk' },
  });
  const payload = jianyingDraftPayload(project([captioned(true)]));
  assert.deepEqual(payload.captions, [{ startMs: 1000, endMs: 1900, text: 'hello world' }],
    'cues sit where the trimmed clip plays the words (clip at 1 s, in-point 2 s); "early" is never heard');
  assert.deepEqual(payload.items.map((item) => [item.startFrame, item.srcInFrame]), [[30, 60]]);
  assert.deepEqual(jianyingDraftPayload(project([captioned(false)])).captions, []);
}

// ── the agent tool and the dialog share the builder ───────────────────────────
{
  const doc = project([
    timeline('other', [clip('elsewhere', 'video', 0, 30)]),
    timeline('active', [clip('shot', 'video', 15, 45, { srcInFrame: 450, playbackRate: 1.5 })]),
  ], 'active');
  const ctx = { getDoc: () => doc } as unknown as AgentContext;
  const body = jianyingExportBody({ draftName: '  Rough cut  ', draftsDir: ' ~/Drafts ' }, ctx);
  assert.deepEqual(body, { draftName: 'Rough cut', draftsDir: '~/Drafts', ...jianyingDraftPayload(doc) });
  assert.deepEqual(body.items.map((item) => [item.name, item.srcInFrame, item.playbackRate]), [['shot', 450, 1.5]],
    'the tool exports the ACTIVE timeline with its source window');
}

console.log('jianyingDraftRequest.verify: ok');
