import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import { execExportQaTool } from './export-qa-tools';

const state = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['v1', 'a1'],
  tracks: { v1: { kind: 'video' as const }, a1: { kind: 'audio' as const } },
  items: [
    { id: 'one', track: 'v1', startFrame: 0, durationInFrames: 60, name: 'one', kind: 'video' as const, src: '/media/uploads/one.mp4' },
    { id: 'two', track: 'v1', startFrame: 60, durationInFrames: 60, name: 'two', kind: 'video' as const, src: '/media/uploads/two.mp4' },
    { id: 'audio', track: 'a1', startFrame: 0, durationInFrames: 120, name: 'audio', kind: 'audio' as const, src: '/media/uploads/audio.wav' },
  ],
};
const ctx = {
  getState: () => state,
  getDoc: () => ({ assets: [], timelines: [], activeTimelineId: 'timeline' }),
  commands: {}, templates: [], audio: [], getCreativeMode: () => null,
} as unknown as AgentContext;

const originalFetch = globalThis.fetch;
let requestBody: Record<string, unknown> = {};
let renderJobResult: Record<string, unknown> | null = null;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('/export/job/')) {
    return new Response(JSON.stringify({
      id: 'render-custom',
      status: 'succeeded',
      progress: 100,
      result: renderJobResult,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  return new Response(JSON.stringify({
    ok: true,
    src: '/media/uploads/export.mp4',
    report: {
      ok: true,
      durationSeconds: 4,
      width: 1920,
      height: 1080,
      fps: 30,
      hasVideo: true,
      hasAudio: true,
      blackFrames: [], frozenFrames: [], silence: [],
      issues: [], summary: { errors: 0, warnings: 0 },
    },
    evidence: {
      mediaType: 'image/jpeg',
      base64: 'ZmFrZS1qcGVn',
      samples: [
        { cutSeconds: 2, sampleSeconds: 1.9, side: 'before' },
        { cutSeconds: 2, sampleSeconds: 2.1, side: 'after' },
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const result = await execExportQaTool('verify_export', {
    src: '/media/uploads/export.mp4', maxCuts: 4,
  }, ctx) as {
    ok: boolean;
    cutCount: number;
    __images: { base64: string }[];
    next: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.cutCount, 1);
  assert.equal(result.__images[0]!.base64, 'ZmFrZS1qcGVn');
  assert.match(result.next, /passed/i);
  assert.equal(requestBody.durationSeconds, 4);
  assert.equal(requestBody.expectsAudio, true);
  assert.deepEqual(requestBody.cutTimesSeconds, [2]);

  renderJobResult = {
    path: '/media/uploads/ranged.mp4',
    name: 'ranged.mp4',
    codec: 'h264',
    durationSeconds: 2,
    width: 1280,
    height: 720,
    fps: 25,
    sourceStartSeconds: 2,
  };
  await execExportQaTool('verify_export', { renderId: 'render-custom' }, ctx);
  assert.equal(requestBody.durationSeconds, 2, 'render metadata overrides full timeline duration');
  assert.equal(requestBody.width, 1280, 'render metadata overrides timeline width');
  assert.equal(requestBody.height, 720, 'render metadata overrides timeline height');
  assert.equal(requestBody.fps, 25, 'render metadata overrides timeline fps');
  assert.deepEqual(requestBody.cutTimesSeconds, [], 'ranged export omits cuts outside its output span');
  console.log('export-qa-tools.check: ok');
} finally {
  globalThis.fetch = originalFetch;
}
