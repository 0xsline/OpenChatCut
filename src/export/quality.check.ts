import assert from 'node:assert/strict';
import {
  assessExportQuality,
  exportQaExpectations,
  parseExportQaLog,
  timelineCutTimesSeconds,
} from './quality';
import type { TimelineState } from '../editor/types';

const parsed = parseExportQaLog(`
[blackdetect @ 0x1] black_start:1.2 black_end:1.7 black_duration:0.5
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 2.1
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 1.2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 3.3
[silencedetect @ 0x3] silence_start: 1.8
[silencedetect @ 0x3] silence_end: 5.9 | silence_duration: 4.1
[Parsed_volumedetect_0 @ 0x4] mean_volume: -18.4 dB
[Parsed_volumedetect_0 @ 0x4] max_volume: -0.0 dB
`);
assert.deepEqual(parsed.blackFrames, [{ startSeconds: 1.2, endSeconds: 1.7, durationSeconds: 0.5 }]);
assert.deepEqual(parsed.frozenFrames, [{ startSeconds: 2.1, endSeconds: 3.3, durationSeconds: 1.2 }]);
assert.deepEqual(parsed.silence, [{ startSeconds: 1.8, endSeconds: 5.9, durationSeconds: 4.1 }]);
assert.equal(parsed.meanVolumeDb, -18.4);
assert.equal(parsed.maxVolumeDb, -0);

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['video-main', 'audio-main'],
  tracks: {
    'video-main': { kind: 'video' },
    'audio-main': { kind: 'audio' },
  },
  items: [
    { id: 'v1', track: 'video-main', startFrame: 0, durationInFrames: 90, name: 'one', kind: 'video', src: '/media/uploads/one.mp4' },
    { id: 'v2', track: 'video-main', startFrame: 90, durationInFrames: 60, name: 'two', kind: 'video', src: '/media/uploads/two.mp4' },
    { id: 'v3-gap', track: 'video-main', startFrame: 180, durationInFrames: 30, name: 'gap', kind: 'video', src: '/media/uploads/three.mp4' },
    { id: 'a1', track: 'audio-main', startFrame: 0, durationInFrames: 210, name: 'mix', kind: 'audio', src: '/media/uploads/mix.wav' },
  ],
};
assert.deepEqual(timelineCutTimesSeconds(state), [3]);
assert.deepEqual(exportQaExpectations(state), {
  durationSeconds: 7,
  width: 1920,
  height: 1080,
  fps: 30,
  expectsAudio: true,
});

const report = assessExportQuality({
  durationSeconds: 7.6,
  width: 1280,
  height: 720,
  fps: 25,
  hasVideo: true,
  hasAudio: true,
  ...parsed,
}, exportQaExpectations(state));
assert.equal(report.ok, false);
assert.ok(report.issues.some((issue) => issue.code === 'duration_mismatch' && issue.severity === 'error'));
assert.ok(report.issues.some((issue) => issue.code === 'resolution_mismatch'));
assert.ok(report.issues.some((issue) => issue.code === 'fps_mismatch'));
assert.ok(report.issues.some((issue) => issue.code === 'black_frames'));
assert.ok(report.issues.some((issue) => issue.code === 'frozen_frames'));
assert.ok(report.issues.some((issue) => issue.code === 'long_silence'));
assert.ok(report.issues.some((issue) => issue.code === 'audio_peak'));

console.log('export quality checks passed');
