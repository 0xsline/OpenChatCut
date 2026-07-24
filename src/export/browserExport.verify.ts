import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import {
  browserScaledExportDimensions,
  browserTimelineBlocker,
  exportVideoWithFallback,
  renderTimelineInBrowser,
} from './browserExport';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [{
    id: 'solid_1',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 60,
    name: 'Background',
    kind: 'solid',
    props: { color: '#111111' },
  }],
};

assert.deepEqual(browserScaledExportDimensions(state, '480p'), {
  width: 854,
  height: 480,
  scale: 480 / 1080,
});
assert.deepEqual(browserScaledExportDimensions({ width: 1080, height: 1920 }, '480p'), {
  width: 480,
  height: 854,
  scale: 480 / 1080,
});

let loaderCalls = 0;
const retimed = await renderTimelineInBrowser({
  state,
  codec: 'h264',
  resolution: '1080p',
  fps: 60,
  loadRenderer: async () => {
    loaderCalls += 1;
    return {} as never;
  },
});
assert.equal(retimed.status, 'unsupported');
assert.equal(loaderCalls, 0, 'frame-rate mismatch must not load the browser renderer');

assert.equal(browserTimelineBlocker({
  ...state,
  items: [{ ...state.items[0], effects: [{ id: 'fx_1', assetId: 'builtin:fx-bloom' }] }],
}), 'contains WebGL clip effects');

assert.equal(browserTimelineBlocker({
  ...state,
  items: [
    { ...state.items[0], id: 'video_1', kind: 'video', src: '/a.mp4' },
    { ...state.items[0], id: 'video_2', kind: 'video', src: '/b.mp4', startFrame: 60 },
  ],
  transitions: [{
    id: 'transition_1',
    type: 'cross-dissolve',
    durationInFrames: 10,
    outgoingItemId: 'video_1',
    incomingItemId: 'video_2',
    trackId: 'V1',
  }],
}), 'contains WebGL Transition');

const capabilityCalls: Array<Record<string, unknown>> = [];
const renderCalls: Array<Record<string, unknown>> = [];
const progressSnapshots: number[] = [];
const blob = new Blob(['browser-video'], { type: 'video/mp4' });
const runtime = {
  canRenderMediaOnWeb: async (options: Record<string, unknown>) => {
    capabilityCalls.push(options);
    return {
      canRender: true,
      issues: [],
      resolvedVideoCodec: options.videoCodec,
      resolvedAudioCodec: options.audioCodec,
      resolvedOutputTarget: 'arraybuffer',
    };
  },
  renderMediaOnWeb: async (options: Record<string, unknown>) => {
    renderCalls.push(options);
    const onProgress = options.onProgress as undefined | ((value: Record<string, unknown>) => void);
    onProgress?.({ progress: 0.5, encodedFrames: 30, renderedFrames: 31, doneIn: null, renderEstimatedTime: 100 });
    return { getBlob: async () => blob, internalState: {} };
  },
};
const loadComposition = async () => ({ TimelineComposition: () => null });

const rendered = await renderTimelineInBrowser({
  state,
  codec: 'h264',
  resolution: '720p',
  fps: 30,
  onProgress: (progress) => progressSnapshots.push(progress.progress),
  loadRenderer: async () => runtime as never,
  loadComposition,
});
assert.equal(rendered.status, 'rendered');
if (rendered.status === 'rendered') assert.equal(await rendered.blob.text(), 'browser-video');
assert.deepEqual(progressSnapshots, [0.5]);
assert.deepEqual(capabilityCalls[0], {
  container: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1280,
  height: 720,
  videoBitrate: 'high',
  audioBitrate: 'high',
});
assert.equal(renderCalls[0].container, 'mp4');
assert.equal(renderCalls[0].scale, 720 / 1080);
assert.equal((renderCalls[0].inputProps as { browserRenderer: boolean }).browserRenderer, true);

await renderTimelineInBrowser({
  state,
  codec: 'vp8',
  resolution: '1080p',
  fps: 30,
  loadRenderer: async () => runtime as never,
  loadComposition,
});
assert.equal(capabilityCalls[1].container, 'webm');
assert.equal(capabilityCalls[1].audioCodec, 'opus');

const unsupported = await renderTimelineInBrowser({
  state,
  codec: 'h264',
  resolution: '1080p',
  fps: 30,
  loadRenderer: async () => ({
    ...runtime,
    canRenderMediaOnWeb: async () => ({
      canRender: false,
      issues: [{ type: 'webcodecs-unavailable', severity: 'error', message: 'WebCodecs unavailable' }],
      resolvedVideoCodec: null,
      resolvedAudioCodec: null,
      resolvedOutputTarget: 'arraybuffer',
    }),
  }) as never,
  loadComposition,
});
assert.deepEqual(unsupported, {
  status: 'unsupported',
  reason: 'WebCodecs unavailable',
  issues: ['WebCodecs unavailable'],
});

let serverCalls = 0;
const browserResult = await exportVideoWithFallback({
  browser: async () => ({ status: 'rendered', blob, issues: [] }),
  server: async () => { serverCalls += 1; return 'server'; },
});
assert.equal(browserResult.engine, 'browser');
assert.equal(serverCalls, 0);

let fallbackReason = '';
const serverResult = await exportVideoWithFallback({
  browser: async () => ({ status: 'unsupported', reason: 'unsupported timeline', issues: [] }),
  server: async () => { serverCalls += 1; return 'server'; },
  onFallback: (reason) => { fallbackReason = reason; },
});
assert.equal(serverResult.engine, 'server');
assert.equal(fallbackReason, 'unsupported timeline');
assert.equal(serverCalls, 1);

const failedBrowserResult = await exportVideoWithFallback({
  browser: async () => { throw new Error('encoder failed'); },
  server: async () => { serverCalls += 1; return 'server'; },
});
assert.equal(failedBrowserResult.engine, 'server');
assert.equal(serverCalls, 2);

await assert.rejects(
  exportVideoWithFallback({
    browser: async () => { throw new DOMException('cancelled', 'AbortError'); },
    server: async () => { serverCalls += 1; return 'server'; },
  }),
  (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
);
assert.equal(serverCalls, 2, 'cancel must never start a server fallback job');

const controller = new AbortController();
controller.abort();
await assert.rejects(
  renderTimelineInBrowser({ state, codec: 'h264', resolution: '1080p', fps: 30, signal: controller.signal }),
  (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
);

console.log('browser export check passed');
