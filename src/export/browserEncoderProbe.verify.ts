// Issue #175: a 1080p60 H.264 browser export failed inside the render with
// "This specific encoder configuration (avc1.640028, 6000000 bps, 1920x1080,
// hardware acceleration: prefer-hardware) is not supported by this browser",
// after the pre-flight had said yes. This pins (1) spec-correct AVC levels for
// the MediaCapabilities probe, (2) the probe config to what the installed
// Mediabunny really hands WebCodecs, and (3) that a refusal routes the export
// to the local renderer before any frame is drawn.
// Run: npx tsx src/export/browserEncoderProbe.verify.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TimelineState } from '../editor/types';
import { avcHighProfileCodecString, h264LevelIdc, mediabunnyAvcLevelIdc } from './h264Level';
import {
  browserEncodingContentType,
  browserHardwareAcceleration,
  browserVideoEncoderConfig,
  probeBrowserEncoder,
  type VideoEncoderSupportProbe,
} from './browserEncoderProbe';
import {
  BROWSER_ENCODER_UNSUPPORTED_REASON,
  inspectBrowserExport,
  renderTimelineInBrowser,
  type BrowserExportOptions,
} from './browserExport';
import { planVideoExportRoute } from './exportRoutePlanner';

// ── 1. AVC level for the stream the export produces (H.264 Annex A) ─────────
const level = (width: number, height: number, fps: number, bitrate = 6_000_000) => (
  avcHighProfileCodecString(h264LevelIdc({ width, height, fps, bitrate }))
);
assert.equal(level(1920, 1080, 30), 'avc1.640028', '1080p30 fits Level 4.0 (244,800 of 245,760 MB/s)');
assert.equal(level(1920, 1080, 25), 'avc1.640028');
assert.equal(level(1920, 1080, 50), 'avc1.64002a', '1080p50 exceeds 4.0/4.1 MaxMBPS');
assert.equal(level(1920, 1080, 60), 'avc1.64002a', '1080p60 needs Level 4.2 (489,600 MB/s)');
assert.equal(level(1920, 1080, 60000 / 1001), 'avc1.64002a', '59.94 fps is Level 4.2 too');
assert.equal(level(3840, 2160, 30, 22_393_000), 'avc1.640033', '2160p30 needs 5.1: 32,400 MBs > 5.0 MaxFS');
assert.equal(level(3840, 2160, 60, 22_393_000), 'avc1.640034', '2160p60 needs 5.2');
assert.equal(level(1280, 720, 30), 'avc1.64001f');
assert.equal(level(1280, 720, 60), 'avc1.640020');
assert.equal(level(854, 480, 30, 1_287_000), 'avc1.64001f', '480p30 exceeds 3.0 MaxMBPS (48,600 > 40,500)');
// Bitrate caps (MaxBR x 1000 bit/s)
assert.equal(level(1920, 1080, 30, 20_000_000), 'avc1.640028');
assert.equal(level(1920, 1080, 30, 20_000_001), 'avc1.640029', 'past 20 Mbps 1080p30 needs 4.1');
assert.equal(level(1920, 1080, 60, 50_000_000), 'avc1.64002a');
assert.equal(level(1920, 1080, 60, 50_000_001), 'avc1.640032', 'past 50 Mbps 1080p60 needs 5.0');
assert.equal(level(3840, 2160, 60, 240_000_000), 'avc1.640034');
assert.equal(level(3840, 2160, 60, 240_000_001), 'avc1.64003d', 'past 240 Mbps 2160p60 needs 6.1');
// Frame shape: neither side may exceed sqrt(8 x MaxFS)
assert.equal(level(8192, 128, 30), 'avc1.640033', 'a 512-macroblock-wide strip first fits Level 5.1');
assert.equal(level(5808, 2160, 30, 30_000_000), 'avc1.64003c', 'the 4K scope frame (49,005 MBs) needs Level 6');
assert.equal(level(8192, 8192, 120, 1_000_000_000), 'avc1.64003e', 'beyond the table: highest level');
for (let fps = 1; fps <= 240; fps += 1) {
  assert.ok(h264LevelIdc({ width: 1920, height: 1080, fps, bitrate: 6_000_000 })
    >= h264LevelIdc({ width: 1920, height: 1080, fps: Math.max(1, fps - 1), bitrate: 6_000_000 }), 'level never drops as fps rises');
}
assert.equal(browserEncodingContentType('h264', { width: 1920, height: 1080, fps: 60, bitrate: 6_000_000 }), 'video/mp4; codecs="avc1.64002a"');
assert.equal(browserEncodingContentType('h264', { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 }), 'video/mp4; codecs="avc1.640028"');
assert.equal(browserEncodingContentType('vp8', { width: 1920, height: 1080, fps: 60, bitrate: 7_200_000 }), 'video/webm; codecs="vp8"');
// What Mediabunny 1.50.8 writes instead: frame size and bitrate only.
assert.equal(mediabunnyAvcLevelIdc(1920, 1080, 6_000_000), 0x28, 'Mediabunny picks 4.0 for 1080p at any fps');
assert.equal(mediabunnyAvcLevelIdc(854, 480, 1_287_000), 0x16);

// ── 2. The probe config IS what Mediabunny hands VideoEncoder ─────────────────
// canEncodeVideo() builds its config with the same buildVideoEncoderConfig()
// as the render's VideoSampleSource, so capturing it through a stub WebCodecs
// compares against the installed library, not a copy of its tables.
const seenByMediabunny: VideoEncoderConfig[] = [];
Object.defineProperty(globalThis, 'VideoEncoder', {
  configurable: true,
  value: {
    isConfigSupported: async (config: VideoEncoderConfig) => {
      seenByMediabunny.push(config);
      return { supported: true, config };
    },
  },
});
const mediabunny = await import('mediabunny');
const withoutUndefined = (config: object) => JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
const sizes = [[1920, 1080], [3840, 2160], [1280, 720], [854, 480], [1080, 1920], [2160, 3840], [5808, 2160], [1600, 1600]] as const;
let parityCases = 0;
for (const codec of ['h264', 'vp8'] as const) {
  for (const [width, height] of sizes) {
    for (const videoBitrate of ['high', 8_000_000, 25_000_000, 60_000_000] as const) {
      const hardwareAcceleration = browserHardwareAcceleration(width, height);
      seenByMediabunny.length = 0;
      await mediabunny.canEncodeVideo(codec === 'h264' ? 'avc' : 'vp8', {
        width,
        height,
        bitrate: videoBitrate === 'high' ? mediabunny.QUALITY_HIGH : videoBitrate,
        hardwareAcceleration,
        latencyMode: 'quality',
      });
      assert.equal(seenByMediabunny.length, 1, `Mediabunny probed ${codec} ${width}x${height} ${videoBitrate}`);
      const { displayWidth, displayHeight, ...ours } = browserVideoEncoderConfig({
        codec, width, height, videoBitrate, hardwareAcceleration,
      });
      assert.deepEqual(withoutUndefined(ours), withoutUndefined(seenByMediabunny[0]!),
        `probe config matches Mediabunny for ${codec} ${width}x${height} ${videoBitrate}`);
      // The render passes the square-pixel size of the frame it encodes.
      assert.deepEqual([displayWidth, displayHeight], [width, height]);
      parityCases += 1;
    }
  }
}
Reflect.deleteProperty(globalThis, 'VideoEncoder');

// The renderer never tells Mediabunny the frame rate or a codec string, so the
// probe must not either. If @remotion/web-renderer starts passing either, the
// probe has to follow; this trips first.
const webRendererSource = readFileSync(fileURLToPath(import.meta.resolve('@remotion/web-renderer')), 'utf8');
const sampleSourceCall = webRendererSource.match(/makeVideoSampleSourceCleanup\(\{[\s\S]*?\}\)/)?.[0];
const addTrackCall = webRendererSource.match(/addVideoTrack\([\s\S]*?\}\)/)?.[0];
assert.ok(sampleSourceCall && addTrackCall, 'web-renderer still builds its VideoSampleSource where this verify looks');
assert.doesNotMatch(sampleSourceCall, /frameRate|framerate|fullCodecString/);
assert.doesNotMatch(addTrackCall, /frameRate|framerate/);

// ── 3. Pre-flight: refusal routes to the local renderer before any frame ─────
const timeline60: TimelineState = {
  fps: 60,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [{
    id: 'clip', track: 'V1', startFrame: 0, durationInFrames: 120, name: 'clip', kind: 'solid', props: { color: '#000' },
  }],
};
let renders = 0;
const renderHardware: string[] = [];
const runtime = {
  canRenderMediaOnWeb: async () => ({
    canRender: true, issues: [], resolvedVideoCodec: 'h264', resolvedAudioCodec: 'aac', resolvedOutputTarget: 'arraybuffer',
  }),
  renderMediaOnWeb: async (options: { hardwareAcceleration?: string }) => {
    renders += 1;
    renderHardware.push(String(options.hardwareAcceleration));
    return { getBlob: async () => new Blob(['mp4']), internalState: {} };
  },
};
const probed: VideoEncoderConfig[] = [];
const refusing: VideoEncoderSupportProbe = async (config) => { probed.push(config); return { supported: false }; };
const accepting: VideoEncoderSupportProbe = async (config) => { probed.push(config); return { supported: true }; };
const exportOptions = (probeVideoEncoder: VideoEncoderSupportProbe | null, state = timeline60): BrowserExportOptions => ({
  state,
  codec: 'h264',
  resolution: '1080p',
  fps: state.fps,
  loadRenderer: async () => runtime as never,
  loadComposition: async () => ({ TimelineComposition: () => null }),
  probeVideoEncoder,
});

const refused = await inspectBrowserExport(exportOptions(refusing));
assert.equal(refused.status, 'unsupported');
assert.equal(refused.status === 'unsupported' && refused.reason, BROWSER_ENCODER_UNSUPPORTED_REASON,
  'the user-facing reason is the neutral notice, not WebCodecs\' message');
assert.ok(refused.issues.some((issue) => issue.includes('avc1.640028 1920x1080 6000000 bps prefer-hardware')),
  'the exact refused config stays available for diagnostics');
assert.deepEqual(withoutUndefined(probed[0]!), {
  codec: 'avc1.640028',
  width: 1920,
  height: 1080,
  displayWidth: 1920,
  displayHeight: 1080,
  bitrate: 6_000_000,
  alpha: 'discard',
  latencyMode: 'quality',
  hardwareAcceleration: 'prefer-hardware',
  avc: { format: 'avc' },
}, 'a 1080p60 export probes the reporter\'s exact encoder config');
assert.equal('framerate' in probed[0]!, false, 'no frame rate: the render never passes one');

const refusedRender = await renderTimelineInBrowser(exportOptions(refusing));
assert.equal(refusedRender.status, 'unsupported');
assert.equal(renders, 0, 'a refused encoder never starts drawing frames');
assert.equal((await renderTimelineInBrowser(exportOptions(null))).status, 'unsupported', 'no VideoEncoder at all');
const throwing: VideoEncoderSupportProbe = async () => { throw new TypeError('Invalid codec'); };
assert.equal((await renderTimelineInBrowser(exportOptions(throwing))).status, 'unsupported');
assert.equal((await probeBrowserEncoder({
  codec: 'h264', width: 1920, height: 1080, videoBitrate: 'high', hardwareAcceleration: 'prefer-hardware',
}, throwing)).supported, false);

const rendered = await renderTimelineInBrowser(exportOptions(accepting));
assert.equal(rendered.status, 'rendered');
assert.deepEqual(renderHardware, ['prefer-hardware'], 'the render uses the preference the probe confirmed');

// Above the 4096 px hardware cap both the probe and the render ask for software.
probed.length = 0;
const scope = { ...timeline60, fps: 30, width: 1920, height: 714 };
await renderTimelineInBrowser({ ...exportOptions(accepting, scope), resolution: '4k' });
assert.equal(probed[0]?.hardwareAcceleration, 'prefer-software');
assert.equal(probed[0]?.codec, 'avc1.64003c');
assert.deepEqual(renderHardware, ['prefer-hardware', 'prefer-software']);

// The route planner sends a refused export straight to the local encoder.
const originalFetch = globalThis.fetch;
const nvenc = { id: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true, transport: 'server' as const };
globalThis.fetch = (async (input: RequestInfo | URL) => {
  assert.equal(String(input), '/export/capabilities');
  return Response.json({ h264: nvenc });
}) as typeof fetch;
try {
  const plan = await planVideoExportRoute(exportOptions(refusing));
  assert.equal(plan.route, 'server');
  assert.deepEqual(plan.engine, nvenc);
  assert.equal(plan.reason, BROWSER_ENCODER_UNSUPPORTED_REASON);
  assert.equal(plan.browser.status, 'unsupported', 'a later local failure must not retry this browser');
} finally {
  globalThis.fetch = originalFetch;
}

// The power-efficiency probe describes the 60 fps stream with its real level.
const encodingQueries: MediaEncodingConfiguration[] = [];
Object.defineProperty(globalThis.navigator, 'mediaCapabilities', {
  configurable: true,
  value: {
    encodingInfo: async (config: MediaEncodingConfiguration) => {
      encodingQueries.push(config);
      return { supported: true, smooth: true, powerEfficient: true };
    },
  },
});
try {
  const efficient = await inspectBrowserExport(exportOptions(accepting));
  assert.deepEqual(efficient, { status: 'supported', issues: [], powerEfficient: true });
  assert.equal(encodingQueries[0]?.video?.contentType, 'video/mp4; codecs="avc1.64002a"');
  assert.equal(encodingQueries[0]?.video?.bitrate, 6_000_000, 'the bitrate the encoder is really given');
  assert.equal(encodingQueries[0]?.video?.framerate, 60);
} finally {
  Reflect.deleteProperty(globalThis.navigator, 'mediaCapabilities');
}

console.log(`browserEncoderProbe.verify: AVC levels, ${parityCases} Mediabunny parity cases and the encoder pre-flight OK`);
