// Pure-logic checks for selection-mode references:
// 29906–30080): prompt-token serialization, timecode formatting, timeline pick
// gesture resolution, canvas-region coordinate math, and the transcript
// word→ms / word→frame mapping with keptSegments. Run:
//   tsx src/agent/selection-refs.check.ts
import assert from 'node:assert';
import type { TimelineItem, TimelineState } from '../editor/types';
import {
  canvasRegionRef, formatFrameTime, itemRectInComposition, itemsInRegion,
  refPromptToken, regionFromDrag, resolveTimelinePick, timepointRef, timerangeRef,
  transcriptSelectionRef,
} from './selection-refs';

const state: TimelineState = { fps: 30, width: 1920, height: 1080, items: [], selectedId: null };

// ── Prompt tokens: @t / @r / @q / @[ / plain @name ────────────────────────
assert.equal(refPromptToken({ name: '00:05.2 时间点', kind: 'timepoint' }), '@t[00:05.2 时间点]');
assert.equal(refPromptToken({ name: 'V1 00:03.0-00:07.0', kind: 'timerange' }), '@t[V1 00:03.0-00:07.0]');
assert.equal(refPromptToken({ name: '画面区域（2 个片段）', kind: 'canvas-region' }), '@r[画面区域（2 个片段）]');
assert.equal(refPromptToken({ name: '“今天我们…”（8 词）', kind: 'transcript-selection' }), '@q[“今天我们…”（8 词）]');
assert.equal(refPromptToken({ name: '口播A.mp4', kind: 'item' }), '@[口播A.mp4]');
assert.equal(refPromptToken({ name: 'b-roll.mp4', kind: 'video' }), '@b-roll.mp4', 'pool assets keep the legacy plain form');

// ── timecode formatting ──────────────────────────────────────────────────────
assert.equal(formatFrameTime(156, 30), '00:05.2');
assert.equal(formatFrameTime(0, 30), '00:00.0');
assert.equal(formatFrameTime(2721, 30), '01:30.7');

// ── timepoint / timerange builders ───────────────────────────────────────────
const tp = timepointRef(156, state);
assert.equal(tp.kind, 'timepoint');
assert.equal(tp.name, '00:05.2 时间点');
assert.deepEqual(
  { fps: tp.metadata.fps, timelineFrameStart: (tp.metadata as { timelineFrameStart: number }).timelineFrameStart },
  { fps: 30, timelineFrameStart: 156 },
);

const tr = timerangeRef(210, 90, state, { trackId: 'V1' }); // reversed input normalizes
assert.equal(tr.kind, 'timerange');
assert.equal(tr.name, 'V1 00:03.0-00:07.0');
assert.ok(tr.kind === 'timerange');
assert.equal(tr.metadata.timelineFrameStart, 90);
assert.equal(tr.metadata.timelineFrameEnd, 210, 'end is exclusive');
assert.equal(tr.metadata.trackAlias, 'V1');

// ── timeline pick gesture resolution ─────────────────────────────────────────
const clip: TimelineItem = { id: 'item_1', track: 'V1', startFrame: 30, durationInFrames: 120, name: '口播A', kind: 'video', src: '/m/a.mp4' };
const stateWithClip: TimelineState = { ...state, items: [clip] };

const rulerClick = resolveTimelinePick({ origin: 'ruler', startFrame: 100, endFrame: 101 }, 3, stateWithClip);
assert.equal(rulerClick?.kind, 'timepoint', 'ruler click below threshold → timepoint');

const rulerDrag = resolveTimelinePick({ origin: 'ruler', startFrame: 100, endFrame: 160 }, 3, stateWithClip);
assert.equal(rulerDrag?.kind, 'timerange', 'ruler drag → timerange');

const clipClick = resolveTimelinePick({ origin: 'clip', startFrame: 50, endFrame: 51, item: clip }, 3, stateWithClip);
assert.ok(clipClick && clipClick.kind === 'item', 'clip click → item reference');
assert.equal(clipClick.id, 'item_1');
assert.equal(clipClick.name, '口播A');
assert.equal(clipClick.metadata.timelineFrameStart, 30);
assert.equal(clipClick.metadata.timelineFrameEnd, 150);
assert.equal(clipClick.metadata.trackAlias, 'V1');

const clipDrag = resolveTimelinePick({ origin: 'clip', startFrame: 50, endFrame: 120, item: clip }, 3, stateWithClip);
assert.ok(clipDrag && clipDrag.kind === 'timerange', 'clip drag → timerange');
assert.equal(clipDrag.metadata.itemId, 'item_1', 'range keeps clip context');
assert.equal(clipDrag.metadata.trackId, 'V1');

const laneClick = resolveTimelinePick({ origin: 'lane', startFrame: 40, endFrame: 41, trackId: 'A1' }, 3, stateWithClip);
assert.equal(laneClick, null, 'empty-lane click without drag picks nothing');
const laneDrag = resolveTimelinePick({ origin: 'lane', startFrame: 40, endFrame: 90, trackId: 'A1' }, 3, stateWithClip);
assert.ok(laneDrag && laneDrag.kind === 'timerange' && laneDrag.metadata.trackAlias === 'A1', 'lane drag carries track');

// ── canvas region: view px → composition coordinates ─────────────────────────
const region = regionFromDrag({ x: 110, y: 60 }, { x: 10, y: 10 }, 640, 360, 1920, 1080);
assert.deepEqual(region, { x: 30, y: 30, width: 300, height: 150 }, 'scale 3x + reversed corners normalized');
assert.equal(regionFromDrag({ x: 5, y: 5 }, { x: 5.1, y: 5.1 }, 640, 360, 1920, 1080), null, 'degenerate drag → null');
const clamped = regionFromDrag({ x: -50, y: -50 }, { x: 9999, y: 9999 }, 640, 360, 1920, 1080);
assert.deepEqual(clamped, { x: 0, y: 0, width: 1920, height: 1080 }, 'clamped to the canvas');

// ── item rect approximation (mirrors TimelineComposition layout) ─────────────
assert.deepEqual(itemRectInComposition(clip, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 }, 'raster media fills the canvas');
const mg: TimelineItem = { id: 'mg1', track: 'V2', startFrame: 0, durationInFrames: 90, name: 'MG', kind: 'motion-graphic', width: 960, height: 540 };
assert.deepEqual(itemRectInComposition(mg, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 }, 'MG design box contain-scales to the canvas');
const scaled: TimelineItem = { ...clip, id: 'item_2', transform: { scale: 0.5, x: 25 } };
assert.deepEqual(itemRectInComposition(scaled, 1920, 1080), { x: 960, y: 270, width: 960, height: 540 }, 'scale about center + x% offset');
assert.equal(itemRectInComposition({ ...clip, kind: 'audio' }, 1920, 1080), null, 'audio has no picture rect');

// ── itemsInRegion: visual, visible, at-frame, intersecting ─────────────────
const audioClip: TimelineItem = { id: 'a1', track: 'A1', startFrame: 0, durationInFrames: 300, name: 'BGM', kind: 'audio', src: '/m/b.mp3' };
const laterClip: TimelineItem = { id: 'item_3', track: 'V2', startFrame: 200, durationInFrames: 50, name: '后段', kind: 'video', src: '/m/c.mp4' };
const hiddenClip: TimelineItem = { id: 'item_4', track: 'V2', startFrame: 0, durationInFrames: 300, name: '隐藏', kind: 'video', src: '/m/d.mp4' };
const regionState: TimelineState = {
  ...state,
  items: [clip, audioClip, laterClip, hiddenClip],
  tracks: { V2: { hidden: true } },
};
const hits = itemsInRegion(regionState, 60, { x: 0, y: 0, width: 400, height: 400 });
assert.deepEqual(hits, ['item_1'], 'audio + hidden-track + out-of-frame clips excluded');
const offRegion = itemsInRegion({ ...regionState, items: [scaled] }, 60, { x: 0, y: 0, width: 200, height: 200 });
assert.deepEqual(offRegion, [], 'region misses the transformed rect');

const cr = canvasRegionRef({ x: 0, y: 0, width: 400, height: 400 }, 60, regionState);
assert.ok(cr.kind === 'canvas-region');
assert.equal(cr.name, '画面区域（1 个片段）');
assert.deepEqual(cr.metadata.containedItems, ['item_1']);
assert.equal(cr.metadata.compositionWidth, 1920);
assert.equal(cr.metadata.timelineFrameStart, 60);

// ── transcript selection: 词→源媒体 ms + 词→帧 (keptSegments 同源) ──────────
const spoken: TimelineItem = {
  id: 'item_t', track: 'A1', startFrame: 90, durationInFrames: 75, name: '口播', kind: 'audio', src: '/m/vo.mp3',
  transcript: [
    { text: '今天', start: 0, end: 500, speaker: 'A' },
    { text: '我们', start: 500, end: 1000, speaker: 'A' },
    { text: '开始', start: 2000, end: 2500, speaker: 'A' },
  ],
};
const ts1 = transcriptSelectionRef(spoken, [1, 0], 30); // unsorted input normalizes
assert.ok(ts1 && ts1.kind === 'transcript-selection');
assert.equal(ts1.name, '“今天我们”（2 词）');
assert.equal(ts1.metadata.selectedText, '今天我们', 'CJK words join without spaces');
assert.deepEqual(ts1.metadata.selectedWordIds, [0, 1]);
assert.equal(ts1.metadata.sourceMediaStartMs, 0);
assert.equal(ts1.metadata.sourceMediaEndMs, 1000);
assert.equal(ts1.metadata.timelineFrameStart, 90, 'clip offset applies');
assert.equal(ts1.metadata.timelineFrameEnd, 120, '1000ms @30fps = 30f after clip start');
assert.equal(ts1.metadata.speakerName, '说话人 1');
assert.equal(ts1.id, 'transcript:item_t:0-1', 'deterministic id dedupes repeat picks');

// deleting the middle word compresses the edited timeline — the mapper must follow
const edited: TimelineItem = { ...spoken, deletedWordIdx: [1], durationInFrames: 30 };
const ts2 = transcriptSelectionRef(edited, [0, 2], 30);
assert.ok(ts2 && ts2.kind === 'transcript-selection');
assert.equal(ts2.metadata.sourceMediaStartMs, 0);
assert.equal(ts2.metadata.sourceMediaEndMs, 2500, 'source ms stay raw word timestamps');
assert.equal(ts2.metadata.timelineFrameStart, 90);
assert.equal(ts2.metadata.timelineFrameEnd, 120, 'kept segments: 15f + 15f after the cut');

// picking only a deleted word: text survives, timeline position does not
const ts3 = transcriptSelectionRef(edited, [1], 30);
assert.ok(ts3 && ts3.kind === 'transcript-selection');
assert.equal('timelineFrameStart' in ts3.metadata, false, 'cut word has no timeline frames');
assert.equal(ts3.metadata.selectedText, '我们');

// English words join with spaces; out-of-range indices are dropped
const english: TimelineItem = {
  ...spoken, id: 'item_e',
  transcript: [
    { text: 'hello', start: 0, end: 400 },
    { text: 'world', start: 400, end: 900 },
  ],
};
const ts4 = transcriptSelectionRef(english, [0, 1, 99], 30);
assert.ok(ts4 && ts4.kind === 'transcript-selection');
assert.equal(ts4.metadata.selectedText, 'hello world');
assert.equal('speakerName' in ts4.metadata, false, 'no diarization → no speakerName');
assert.equal(transcriptSelectionRef(english, [99], 30), null, 'no valid words → no reference');

// eslint-disable-next-line no-console
console.log('selection-refs.check: all assertions passed');
