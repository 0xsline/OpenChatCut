// Runnable check: `npx tsx src/agent/tools/probe-tools.verify.ts`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentContext } from '../context';
import { execProbeTool, parseProbe } from './probe-tools';

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

// ── transport: the tool probes through the app's own ffprobe route, never the e2b sandbox ──
// The live failure was "probe_media: e2b sandbox is not configured" on a machine with no
// E2B key, while every other media feature was running the bundled ffprobe.
const source = readFileSync(new URL('./probe-tools.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\/e2b\//, 'probe_media must not route through the sandbox proxy');
assert.match(source, /fetch\('\/api\/probe-media'/, 'probe_media calls the local ffprobe route');

const ctx = {
  getDoc: () => ({ assets: [{ id: 'asset-clip', src: '/media/uploads/clip.mp4' }, { id: 'asset-mg', src: '' }] }),
  getState: () => ({ assets: [] }),
} as unknown as AgentContext;
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; body: unknown }> = [];
const respond = (status: number, body: unknown): typeof fetch => (async (input, init) => {
  calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
try {
  globalThis.fetch = respond(200, {
    ok: true,
    probe: {
      format: { duration: '12.5' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
        { codec_type: 'audio', codec_name: 'aac', channels: 2 },
      ],
    },
  });
  const probed = await execProbeTool('probe_media', { source: 'asset-clip' }, ctx) as Record<string, unknown>;
  assert.deepEqual(calls.at(-1), { url: '/api/probe-media', body: { source: '/media/uploads/clip.mp4' } }, 'asset ids resolve to the pool src before the route is called');
  assert.equal(probed.ok, true);
  assert.equal(probed.hasAudioTrack, true);
  assert.equal(probed.fps, 25);
  assert.equal(probed.durationSeconds, 12.5);
  assert.match(String(probed.next), /hasAudioTrack=true/);

  const direct = await execProbeTool('probe_media', { source: 'https://example.com/a.mp4' }, ctx) as Record<string, unknown>;
  assert.equal(direct.ok, true);
  assert.deepEqual(calls.at(-1)?.body, { source: 'https://example.com/a.mp4' }, 'public URLs are handed to the route, which fetches them SSRF-safely');

  globalThis.fetch = respond(400, { error: 'ffprobe exited 1: Invalid data found when processing input' });
  const failed = await execProbeTool('probe_media', { source: 'asset-clip' }, ctx) as Record<string, unknown>;
  assert.match(String(failed.error), /ffprobe exited 1/);
  assert.match(String(failed.hint), /finalize_uploaded_asset/);
  assert.doesNotMatch(JSON.stringify(failed), /e2b|sandbox/i, 'a probe failure no longer blames the sandbox');

  const noFile = await execProbeTool('probe_media', { source: 'asset-mg' }, ctx) as Record<string, unknown>;
  assert.match(String(noFile.error), /has no media file/);
  const ambiguous = await execProbeTool('probe_media', { source: 'asset' }, ctx) as Record<string, unknown>;
  assert.match(String(ambiguous.error), /no unique asset/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('probe-tools.verify: explicit quality risks, clean result, and local ffprobe transport ok');
