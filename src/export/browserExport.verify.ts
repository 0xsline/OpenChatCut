import assert from 'node:assert/strict';
import { clearExportHistory, listExportHistory } from '../persist/exportHistoryStore';
import type { TimelineState } from '../editor/types';

import {
  browserScaledExportDimensions,
  browserTimelineBlocker,
  exportVideoWithFallback,
  renderTimelineInBrowser,
  type BrowserExportAttempt,
} from './browserExport';
import type { ExportDestination } from './exportDestination';
import { saveBrowserResult, type VideoExportContext } from './videoExportOperation';
interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value?: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value) => { resolvePromise(value as Value); },
  };
}

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

function assertBrowserDimensions(
  source: { width: number; height: number },
  resolution: Parameters<typeof browserScaledExportDimensions>[1],
  expected: { width: number; height: number },
): void {
  const actual = browserScaledExportDimensions(source, resolution);
  assert.deepEqual({ width: actual.width, height: actual.height }, expected);
  assert.equal(Math.ceil(source.width * actual.scale), expected.width);
  assert.equal(Math.ceil(source.height * actual.scale), expected.height);
}

assertBrowserDimensions(state, '480p', { width: 854, height: 480 });
assertBrowserDimensions({ width: 1080, height: 1920 }, '480p', { width: 480, height: 854 });
assertBrowserDimensions(state, '4k', { width: 3840, height: 2160 });
assertBrowserDimensions({ width: 1080, height: 1920 }, '4k', { width: 2160, height: 3840 });
const upscaled480p = browserScaledExportDimensions({ width: 854, height: 480 }, '4k');
assert.equal(upscaled480p.height, 2160);
assert.equal(upscaled480p.width % 2, 0);
assert.equal(Math.ceil(854 * upscaled480p.scale), upscaled480p.width);
assert.equal(Math.ceil(480 * upscaled480p.scale), upscaled480p.height);
const portraitCustom = browserScaledExportDimensions({ width: 100, height: 138 }, '4k');
assert.deepEqual({ width: portraitCustom.width, height: portraitCustom.height }, { width: 2160, height: 2980 });
assert.equal(Math.ceil(100 * portraitCustom.scale), portraitCustom.width);
assert.equal(Math.ceil(138 * portraitCustom.scale), portraitCustom.height);
const narrowCustom = browserScaledExportDimensions({ width: 25, height: 45 }, '4k');
assert.deepEqual({ width: narrowCustom.width, height: narrowCustom.height }, { width: 2160, height: 3888 });
assert.equal(Math.ceil(25 * narrowCustom.scale), narrowCustom.width);
assert.equal(Math.ceil(45 * narrowCustom.scale), narrowCustom.height);




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

// Real-render verification in this branch proved web-renderer's WebCodecs path
// reliably captures WebGL clip effects and GLSL transitions (1080p × 360f,
// zero black frames, distinct per-frame content). So a timeline carrying them is
// NO LONGER barred from the fast browser-export path — it must yield null.
assert.equal(browserTimelineBlocker({
  ...state,
  items: [{ ...state.items[0], effects: [{ id: 'fx_1', assetId: 'builtin:fx-bloom' }] }],
}), null, 'WebGL clip effect must not block the browser fast-export path');

assert.equal(browserTimelineBlocker({
  ...state,
  items: [
    { ...state.items[0], id: 'video_1', kind: 'video', src: '/a.mp4' },
    { ...state.items[0], id: 'video_2', kind: 'video', src: '/b.mp4', startFrame: 60 },
  ],
  transitions: [{
    id: 'transition_1',
    type: 'organic-dissolve',
    durationInFrames: 10,
    outgoingItemId: 'video_1',
    incomingItemId: 'video_2',
    trackId: 'V1',
  }],
}), null, 'GLSL transition must not block the browser fast-export path');

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
assert.equal(renderCalls[0].scale, browserScaledExportDimensions(state, '720p').scale);
assert.equal((renderCalls[0].inputProps as { browserRenderer: boolean }).browserRenderer, true);

await renderTimelineInBrowser({
  state,
  codec: 'vp8',
  resolution: '1080p',
  fps: 30,
  videoBitrate: 12_000_000,
  loadRenderer: async () => runtime as never,
  loadComposition,
});
assert.equal(capabilityCalls[1].container, 'webm');
assert.equal(capabilityCalls[1].audioCodec, 'opus');
assert.equal(capabilityCalls[1].videoBitrate, 12_000_000);
assert.equal(renderCalls[1].videoBitrate, 12_000_000);

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

interface BrowserDeliveryContextOptions {
  autoQaEnabled: boolean;
  destination: ExportDestination;
  markTargetCommitted?: () => void;
  verifyCompletedExport?: VideoExportContext['verifyCompletedExport'];
}

function browserDeliveryContext(options: BrowserDeliveryContextOptions): VideoExportContext {
  return {
    autoQaEnabled: options.autoQaEnabled,
    browserAbortRef: { current: null },
    beginTargetCommit: () => undefined,
    endTargetCommit: () => undefined,
    destination: options.destination,
    exportServerVideo: async () => ({}),
    markTargetCommitted: options.markTargetCommitted ?? (() => undefined),
    options: {
      state,
      projectId: 'project-browser-lifecycle',
      projectName: 'Lifecycle',
      base: 'browser-lifecycle',
      tab: 'video',
      codec: 'h264',
      resolution: '1080p',
      fps: 30,
      subtitleFormat: 'srt',
      subtitleCaptions: null,
      nleFormat: 'fcp_xml',
      includeMg: false,
      mgItems: [],
      onClose: () => undefined,
    },
    setBusy: () => undefined,
    setEngineInfo: () => undefined,
    setEngineReason: () => undefined,
    setProgress: () => undefined,
    setQa: () => undefined,
    setRenderEngine: () => undefined,
    t: (key) => key,
    verifyCompletedExport: options.verifyCompletedExport ?? (async () => undefined),
  };
}

const browserEngine = {
  id: 'browser-webcodecs',
  label: 'WebCodecs',
  hardware: true,
  transport: 'browser',
} as const;
const renderedAttempt: Extract<BrowserExportAttempt, { status: 'rendered' }> = {
  status: 'rendered',
  blob,
  issues: [],
};

await clearExportHistory();
const beforeWriteController = new AbortController();
beforeWriteController.abort(new DOMException('cancelled', 'AbortError'));
let beforeWriteCalls = 0;
let beforeWriteCommits = 0;
const beforeWriteDestination: ExportDestination = {
  type: 'browser-file',
  label: 'browser-lifecycle.mp4',
  handle: {
    kind: 'file',
    name: 'browser-lifecycle.mp4',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async () => { beforeWriteCalls += 1; },
      close: async () => undefined,
    }),
  },
};
await assert.rejects(
  saveBrowserResult(
    browserDeliveryContext({
      autoQaEnabled: false,
      destination: beforeWriteDestination,
      markTargetCommitted: () => { beforeWriteCommits += 1; },
    }),
    renderedAttempt,
    browserEngine,
    performance.now(),
    beforeWriteController.signal,
  ),
  (error) => error instanceof DOMException && error.name === 'AbortError',
);
assert.equal(beforeWriteCalls, 0, 'rendered output cancelled before save never opens the writer');
assert.equal(beforeWriteCommits, 0);
assert.equal((await listExportHistory()).length, 0);

await clearExportHistory();
const deliveryOriginalFetch = globalThis.fetch;
const qaStarted = deferred<void>();
const qaGate = deferred<void>();
const qaController = new AbortController();
let stagedCleanup = 0;
let qaWrites = 0;
let qaCommits = 0;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith('/export/stage?')) {
    assert.equal(init?.signal, qaController.signal);
    return Response.json({
      path: '/media/uploads/openchatcut-export-stage-browser-lifecycle.mp4',
      sizeBytes: blob.size,
    });
  }
  if (url.startsWith('/export/stage/')) {
    stagedCleanup += 1;
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected request: ${url}`);
}) as typeof fetch;
const qaDestination: ExportDestination = {
  type: 'browser-file',
  label: 'browser-lifecycle.mp4',
  handle: {
    kind: 'file',
    name: 'browser-lifecycle.mp4',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async () => { qaWrites += 1; },
      close: async () => undefined,
    }),
  },
};
const qaSaving = saveBrowserResult(
  browserDeliveryContext({
    autoQaEnabled: true,
    destination: qaDestination,
    markTargetCommitted: () => { qaCommits += 1; },
    verifyCompletedExport: async (_completed, signal) => {
      assert.equal(signal, qaController.signal);
      qaStarted.resolve();
      await qaGate.promise;
    },
  }),
  renderedAttempt,
  browserEngine,
  performance.now(),
  qaController.signal,
);
await qaStarted.promise;
qaController.abort(new DOMException('cancelled', 'AbortError'));
qaGate.resolve();
await assert.rejects(
  qaSaving,
  (error) => error instanceof DOMException && error.name === 'AbortError',
);
globalThis.fetch = deliveryOriginalFetch;
assert.equal(stagedCleanup, 1, 'cancelled browser QA removes its staged export');
assert.equal(qaWrites, 0, 'cancelled browser QA never writes the destination');
assert.equal(qaCommits, 0);
assert.equal((await listExportHistory()).length, 0);

await clearExportHistory();
const writeStarted = deferred<void>();
const writeGate = deferred<void>();
const writeController = new AbortController();
let writerAborts = 0;
let writerCloses = 0;
let writeCommits = 0;
const pendingWriteDestination: ExportDestination = {
  type: 'browser-file',
  label: 'browser-lifecycle.mp4',
  handle: {
    kind: 'file',
    name: 'browser-lifecycle.mp4',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async () => {
        writeStarted.resolve();
        await writeGate.promise;
      },
      close: async () => { writerCloses += 1; },
      abort: async () => { writerAborts += 1; },
    }),
  },
};
const pendingWrite = saveBrowserResult(
  browserDeliveryContext({
    autoQaEnabled: false,
    destination: pendingWriteDestination,
    markTargetCommitted: () => { writeCommits += 1; },
  }),
  renderedAttempt,
  browserEngine,
  performance.now(),
  writeController.signal,
);
await writeStarted.promise;
writeController.abort(new DOMException('cancelled', 'AbortError'));
writeGate.resolve();
await assert.rejects(
  pendingWrite,
  (error) => error instanceof DOMException && error.name === 'AbortError',
);
assert.equal(writerAborts, 1, 'pending browser destination write aborts once');
assert.equal(writerCloses, 0);
assert.equal(writeCommits, 0);
assert.equal((await listExportHistory()).length, 0);

await clearExportHistory();
const committedCloseStarted = deferred<void>();
const committedCloseGate = deferred<void>();
const committedController = new AbortController();
let normalWrites = 0;
let normalCloses = 0;
let normalCommits = 0;
let normalAborts = 0;
const normalDestination: ExportDestination = {
  type: 'browser-file',
  label: 'browser-lifecycle.mp4',
  handle: {
    kind: 'file',
    name: 'browser-lifecycle.mp4',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async () => { normalWrites += 1; },
      close: async () => {
        normalCloses += 1;
        committedCloseStarted.resolve();
        await committedCloseGate.promise;
      },
      abort: async () => { normalAborts += 1; },
    }),
  },
};
const committedSaving = saveBrowserResult(
  browserDeliveryContext({
    autoQaEnabled: false,
    destination: normalDestination,
    markTargetCommitted: () => { normalCommits += 1; },
  }),
  renderedAttempt,
  browserEngine,
  performance.now(),
  committedController.signal,
);
await committedCloseStarted.promise;
committedController.abort(new DOMException('late cancellation', 'AbortError'));
committedCloseGate.resolve();
await committedSaving;
const historyTick = deferred<void>();
setTimeout(() => { historyTick.resolve(); }, 0);
await historyTick.promise;
assert.equal(normalWrites, 1);
assert.equal(normalCloses, 1);
assert.equal(normalAborts, 1);
assert.equal(normalCommits, 1);
assert.equal((await listExportHistory()).some((entry) => entry.name === 'browser-lifecycle.mp4'), true);

const controller = new AbortController();
controller.abort();
await assert.rejects(
  renderTimelineInBrowser({ state, codec: 'h264', resolution: '1080p', fps: 30, signal: controller.signal }),
  (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
);

console.log('browser export check passed');
