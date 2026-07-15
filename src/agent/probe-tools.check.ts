// Pure-logic check for probe_media's ffprobe JSON normalizer. Run:
//   tsx src/agent/probe-tools.check.ts
import assert from 'node:assert';
import { parseProbe } from './probe-tools';

// ── video + audio (a normal clip) ──
const av = parseProbe({
  streams: [
    { codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30/1', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '5.76' },
});
assert.deepEqual(av, {
  durationSeconds: 5.76, width: 1920, height: 1080, fps: 30,
  hasAudioTrack: true, hasVideoTrack: true, videoCodec: 'h264', audioCodec: 'aac',
}, 'video+audio parsed fully');

// ── silent b-roll: video stream, NO audio stream → hasAudioTrack false (skips ASR) ──
const silent = parseProbe({
  streams: [{ codec_type: 'video', width: 1280, height: 720, r_frame_rate: '25/1' }],
  format: { duration: '10' },
});
assert.equal(silent.hasAudioTrack, false, 'no audio stream → hasAudioTrack false');
assert.equal(silent.hasVideoTrack, true, 'has video');
assert.equal(silent.fps, 25, 'fps 25');
assert.equal(silent.durationSeconds, 10, 'duration 10');

// ── audio only (mp3): no video, no dims, has audio ──
const audioOnly = parseProbe({
  streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
  format: { duration: '183.4' },
});
assert.equal(audioOnly.hasVideoTrack, false, 'no video');
assert.equal(audioOnly.hasAudioTrack, true, 'has audio');
assert.equal(audioOnly.width, undefined, 'no width for audio-only');
assert.equal(audioOnly.durationSeconds, 183.4, 'mp3 duration');

// ── NTSC fractional frame rate 30000/1001 → 29.97 ──
assert.equal(parseProbe({ streams: [{ codec_type: 'video', r_frame_rate: '30000/1001' }] }).fps, 29.97, 'NTSC fps');

// ── r_frame_rate "0/0" is invalid → fall back to avg_frame_rate ──
assert.equal(parseProbe({ streams: [{ codec_type: 'video', r_frame_rate: '0/0', avg_frame_rate: '24/1' }] }).fps, 24, 'falls back to avg_frame_rate');

// ── duration on the stream when format lacks it ──
assert.equal(parseProbe({ streams: [{ codec_type: 'audio', duration: '12.5' }] }).durationSeconds, 12.5, 'stream-level duration');

// ── malformed input never throws; everything absent ──
for (const bad of [null, undefined, {}, { streams: 'nope' }, { streams: [] }, 42, 'x']) {
  const r = parseProbe(bad);
  assert.equal(r.hasAudioTrack, false);
  assert.equal(r.hasVideoTrack, false);
  assert.equal(r.durationSeconds, undefined);
  assert.equal(r.fps, undefined);
}

console.log('probe-tools.check.ts OK');
