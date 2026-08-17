import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  audioMediaTimeToTimelineFrame,
  type AudibleAudioItem,
} from './usePlayheadPaint';

// Media time -> timeline frame mapping (marking-mode audio clock).
// The audible media element reports SOURCE seconds; the timeline frame of the
// audible content is item.startFrame + (mediaSeconds*fps - srcInFrame) / rate.

const base: AudibleAudioItem = { startFrame: 0, playbackRate: 1, srcInFrame: 0, src: '/media/uploads/x.mp3' };

// Plain rate-1, srcIn 0: frame == media seconds * fps (the marking workflow:
// 0.5x-processed export played back at 1.0). The caller rounds to whole
// frames, so assert through the same rounding.
assert.equal(audioMediaTimeToTimelineFrame(1.0, base, 30), 30);
assert.equal(Math.round(audioMediaTimeToTimelineFrame(11 / 30, base, 30)), 11);
assert.equal(audioMediaTimeToTimelineFrame(0, base, 30), 0);

// Item starting mid-timeline: the playhead offset shifts with the item start.
assert.equal(audioMediaTimeToTimelineFrame(1.0, { ...base, startFrame: 820 }, 30), 850);

// Source in-point: media time is measured from the trimmed-in source region.
// srcInFrame 30 == 1s of leading source cut; media t=1s is then the window start.
assert.equal(
  audioMediaTimeToTimelineFrame(1.0, { ...base, srcInFrame: 30 }, 30),
  0,
  'srcInFrame shifts the mapping so media t=1s maps back to frame 0',
);
assert.equal(
  audioMediaTimeToTimelineFrame(3.0, { ...base, srcInFrame: 30 }, 30),
  60,
);

// Rate-stretched audio item: 0.5x means one source second covers two timeline
// seconds worth of frames.
assert.equal(
  audioMediaTimeToTimelineFrame(2.0, { ...base, playbackRate: 0.5 }, 30),
  120,
  '0.5x: 2 media seconds == 120 timeline frames at 30fps',
);

// Negative / sub-frame results round naturally at the caller; the pure mapping
// stays exact.
assert.equal(audioMediaTimeToTimelineFrame(0.5, { ...base, srcInFrame: 30 }, 30), -15);

// Wiring assertions: the controller must expose the audible audio item and the
// paint hook must actually run the audio-clock loop while playing.
const controllerSource = readFileSync(new URL('./useTimelineController.ts', import.meta.url), 'utf8');
assert.match(
  controllerSource,
  /getAudibleItem = useCallback\(\\(playheadFrame: number\): AudibleAudioItem \| null =>/,
  'controller must expose the audible audio item for marking mode',
);
assert.match(
  controllerSource,
  /it\.kind === 'audio' && !!it\.src/,
  'only audio items qualify for the audio clock',
);

const paintSource = readFileSync(new URL('./usePlayheadPaint.ts', import.meta.url), 'utf8');
assert.match(
  paintSource,
  /if \(lastAudioFrameRef\.current !== null\) return;/,
  'wall-clock frameupdate must yield to the audio clock while marking mode is active',
);
assert.match(
  paintSource,
  /audioMediaTimeToTimelineFrame\(mediaSec, item, fpsRef\.current\)/,
  'the audio-clock loop must map media time through the item geometry',
);
assert.match(
  paintSource,
  /lastAudioFrameRef\.current = null;/,
  'the audio lock must release when no audible media element is available',
);

console.log('usePlayheadPaint.verify: marking-mode audio clock passed');
