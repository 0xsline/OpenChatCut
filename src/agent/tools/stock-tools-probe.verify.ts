// download_media consumes the measurements the import route makes at download time, so
// the agent gets duration, dimensions and the audio-track flag from the same call — no
// probe_media round and no second download — and bytes that are not media never land.
import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execStockTool } from './stock-tools';

const base = docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [] });
const draft = makeDraft(base);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const originalFetch = globalThis.fetch;
const respond = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})) as typeof fetch;

try {
  globalThis.fetch = respond({
    ok: true,
    path: '/media/uploads/song.mp3',
    filename: 'SoundHelix-Song-1.mp3',
    probe: { durationSeconds: 372.7, hasAudioTrack: true, hasVideoTrack: false, audioCodec: 'mp3', qualityRisks: [] },
  });
  const audio = await execStockTool('download_media', { url: 'https://cdn.example.com/SoundHelix-Song-1.mp3' }, ctx) as {
    succeeded: number; results: Array<Record<string, unknown>>;
  };
  assert.equal(audio.succeeded, 1);
  const row = audio.results[0]!;
  assert.equal(row.local, true);
  assert.deepEqual(row.probe, { durationSeconds: 372.7, hasAudioTrack: true, hasVideoTrack: false, audioCodec: 'mp3', qualityRisks: [] },
    'the measurements ride along in the tool result');
  const asset = draft.getDoc().assets.find((candidate) => candidate.id === row.assetId);
  assert.ok(asset);
  assert.equal(asset.durationInFrames, Math.round(372.7 * 30), 'pool duration comes from the probe, not a guess');

  globalThis.fetch = respond({
    ok: true,
    path: '/media/uploads/clip.mp4',
    probe: { durationSeconds: 12.5, width: 1280, height: 720, fps: 25, hasAudioTrack: false, hasVideoTrack: true, videoCodec: 'h264', qualityRisks: [] },
  });
  const video = await execStockTool('download_media', { url: 'https://cdn.example.com/clip.mp4' }, ctx) as {
    results: Array<Record<string, unknown>>;
  };
  const clip = draft.getDoc().assets.find((candidate) => candidate.id === video.results[0]!.assetId);
  assert.deepEqual([clip?.width, clip?.height, clip?.durationInFrames], [1280, 720, 375], 'dimensions and duration come from the probe');

  globalThis.fetch = respond({ ok: false, error: 'downloaded file is not readable mp4: ffprobe exited 1: Invalid data', code: 'not_media' });
  const before = draft.getDoc().assets.length;
  const notMedia = await execStockTool('download_media', { url: 'https://cdn.example.com/blocked.mp4' }, ctx) as {
    failed: number; results: Array<Record<string, unknown>>;
  };
  assert.equal(notMedia.failed, 1);
  assert.match(String(notMedia.results[0]!.error), /not readable mp4/);
  assert.equal(draft.getDoc().assets.length, before, 'a not_media download never enters the pool');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('stock-tools-probe.verify: import-time probe consumed, not_media rejected');
