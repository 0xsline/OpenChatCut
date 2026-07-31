// Runnable check: `npx tsx src/agent/tools/probe-tools.verify.ts`.
import assert from 'node:assert/strict';
import { parseProbe } from './probe-tools';

const risky = parseProbe({
  format: { duration: '2.5' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 640,
      height: 360,
      r_frame_rate: '30/1',
      avg_frame_rate: '18/1',
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 1 },
  ],
});
assert.equal(risky.fps, 18, 'average frame rate is the usable timeline estimate');
assert.ok(risky.qualityRisks.some((risk) => risk.startsWith('low_resolution:')));
assert.ok(risky.qualityRisks.some((risk) => risk.startsWith('mono_audio:')));
assert.ok(risky.qualityRisks.some((risk) => risk.startsWith('very_short:')));
assert.ok(risky.qualityRisks.some((risk) => risk.startsWith('variable_frame_rate:')));
assert.ok(risky.qualityRisks.some((risk) => risk.startsWith('low_frame_rate:')));

const clean = parseProbe({
  format: { duration: '20' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      r_frame_rate: '30000/1001',
      avg_frame_rate: '30000/1001',
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 2 },
  ],
});
assert.deepEqual(clean.qualityRisks, []);

console.log('probe-tools.verify: explicit quality risks and clean result ok');
