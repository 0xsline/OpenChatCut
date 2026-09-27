// Issue #175: when the browser path gives way to the local renderer, the user
// saw WebCodecs' failure as an error; and when the local render later failed,
// the dialog showed the browser rescue's stale WebCodecs message instead of
// the local engine's own error. Run: npx tsx src/export/videoExportFallback.verify.ts
import assert from 'node:assert/strict';
import type { SetStateAction } from 'react';
import type { TimelineState } from '../editor/types';
import {
  BROWSER_ENCODER_UNSUPPORTED_REASON,
  BROWSER_RENDER_INCOMPLETE_REASON,
  browserFallbackReason,
  type BrowserExportAttempt,
  type BrowserExportInspection,
} from './browserExport';
import type { ExportDestination } from './exportDestination';
import type { ExportRoutePlan } from './exportRoutePlanner';
import { ServerRenderError } from './serverExportOperation';
import type { ExportEngineInfo, ExportProgress, RenderEngine } from './exportWorkflowTypes';
import { createVideoExporter, type VideoExportContext } from './videoExportOperation';

const WEBCODECS_REFUSAL = 'This specific encoder configuration (avc1.640028, 6000000 bps, 1920x1080, hardware '
  + 'acceleration: prefer-hardware) is not supported by this browser. Consider using another codec or changing '
  + 'your video parameters.';

assert.equal(browserFallbackReason(new Error(WEBCODECS_REFUSAL)), BROWSER_ENCODER_UNSUPPORTED_REASON);
assert.equal(browserFallbackReason(new Error('VideoEncoder is not supported by this browser.')), BROWSER_ENCODER_UNSUPPORTED_REASON);
assert.equal(browserFallbackReason(new Error('EncodingError: Encoder failure')), BROWSER_RENDER_INCOMPLETE_REASON);
assert.equal(browserFallbackReason('delayRender() was called but not cleared'), BROWSER_RENDER_INCOMPLETE_REASON);

const state: TimelineState = {
  fps: 60,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [{ id: 'clip', track: 'V1', startFrame: 0, durationInFrames: 120, name: 'clip', kind: 'solid', props: { color: '#000' } }],
};
const webcodecs: ExportEngineInfo = { id: 'webcodecs', label: 'WebCodecs · 本机编码', hardware: false, transport: 'browser' };
const nvenc: ExportEngineInfo = { id: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true, transport: 'server' };
const supported: BrowserExportInspection = { status: 'supported', issues: [] };

function plan(route: 'browser' | 'server', browser: BrowserExportInspection = supported): ExportRoutePlan {
  return {
    route,
    engine: route === 'browser' ? webcodecs : nvenc,
    browserEngine: webcodecs,
    serverEngine: nvenc,
    browser,
    reason: route === 'browser' ? '浏览器兼容且无需额外渲染进程' : '检测到本机硬件编码器',
  };
}

function state$<Value>(initial: Value) {
  let value = initial;
  return {
    get: () => value,
    set: (next: SetStateAction<Value>) => {
      value = typeof next === 'function' ? (next as (current: Value) => Value)(value) : next;
    },
  };
}

interface Harness {
  context: VideoExportContext;
  serverCalls: () => number;
  browserCalls: () => number;
  writes: () => number;
  engineReason: () => string | null;
  engineInfo: () => ExportEngineInfo | null;
  renderEngine: () => RenderEngine;
  progress: () => ExportProgress | null;
}

function harness(options: {
  route: ExportRoutePlan;
  server: () => Promise<void>;
  browser: () => Promise<BrowserExportAttempt>;
}): Harness {
  let serverCalls = 0;
  let browserCalls = 0;
  let writes = 0;
  const engineReason = state$<string | null>(null);
  const engineInfo = state$<ExportEngineInfo | null>(null);
  const renderEngine = state$<RenderEngine>('idle');
  const progress = state$<ExportProgress | null>({ phase: 'preparing', percent: 0, startedAt: 0 });
  const destination: ExportDestination = {
    type: 'browser-file',
    label: 'fallback.mp4',
    handle: {
      kind: 'file',
      name: 'fallback.mp4',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async () => { writes += 1; }, close: async () => undefined }),
    },
  };
  const context: VideoExportContext = {
    autoQaEnabled: false,
    browserAbortRef: { current: null },
    destination,
    exportServerVideo: async () => { serverCalls += 1; await options.server(); return {}; },
    beginTargetCommit: () => undefined,
    endTargetCommit: () => undefined,
    markTargetCommitted: () => undefined,
    options: {
      state,
      projectId: 'issue-175',
      projectName: 'issue-175',
      base: 'fallback',
      tab: 'video',
      codec: 'h264',
      resolution: '1080p',
      fps: 60,
      subtitleFormat: 'srt',
      subtitleCaptions: null,
      nleFormat: 'fcp_xml',
      includeMg: false,
      mgItems: [],
      onClose: () => undefined,
    },
    setBusy: () => undefined,
    setEngineInfo: engineInfo.set,
    setEngineReason: engineReason.set,
    setProgress: progress.set,
    setQa: () => undefined,
    setRenderEngine: renderEngine.set,
    // Echo the key with its params so assertions can see what reaches the UI.
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    verifyCompletedExport: async () => undefined,
    planRoute: async () => options.route,
    renderInBrowser: async () => { browserCalls += 1; return options.browser(); },
  };
  return {
    context,
    serverCalls: () => serverCalls,
    browserCalls: () => browserCalls,
    writes: () => writes,
    engineReason: engineReason.get,
    engineInfo: engineInfo.get,
    renderEngine: renderEngine.get,
    progress: progress.get,
  };
}

const warnings: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args); };
try {
  // ── Browser first, WebCodecs refuses mid-export → local renderer, neutral notice
  {
    const run = harness({
      route: plan('browser'),
      server: async () => undefined,
      browser: async () => { throw new Error(WEBCODECS_REFUSAL); },
    });
    await createVideoExporter(run.context)();
    assert.equal(run.serverCalls(), 1, 'the local renderer takes over');
    assert.equal(run.engineReason(), BROWSER_ENCODER_UNSUPPORTED_REASON, 'badge tooltip is the neutral notice');
    assert.deepEqual(run.engineInfo(), nvenc);
    const detail = run.progress()?.detail ?? '';
    assert.ok(detail.includes(BROWSER_ENCODER_UNSUPPORTED_REASON), 'progress explains the switch');
    assert.ok(!detail.includes('This specific encoder configuration') && !run.engineReason()?.includes('encoder configuration'),
      'WebCodecs\' raw failure is not presented to the user');
    assert.ok(warnings.some((entry) => entry.some((value) => value instanceof Error && value.message === WEBCODECS_REFUSAL)),
      'the raw failure is still logged for diagnosis');
  }

  // ── Any other browser failure gets the generic notice
  {
    const run = harness({
      route: plan('browser'),
      server: async () => undefined,
      browser: async () => { throw new Error('EncodingError: Encoder failure'); },
    });
    await createVideoExporter(run.context)();
    assert.equal(run.engineReason(), BROWSER_RENDER_INCOMPLETE_REASON);
  }

  // ── Local first, local fails, browser rescue refused → the LOCAL error is the outcome
  {
    const localFailure = new ServerRenderError(new Error('NVENC render stalled at frame 1200'));
    const run = harness({
      route: plan('server'),
      server: async () => { throw localFailure; },
      browser: async () => { throw new Error(WEBCODECS_REFUSAL); },
    });
    await assert.rejects(createVideoExporter(run.context)(), (error: unknown) => error === localFailure,
      'the dialog reports the local engine\'s failure, not the rescue\'s WebCodecs message');
    assert.equal(run.browserCalls(), 1);
    assert.equal(run.renderEngine(), 'server', 'the badge returns to the engine whose error is shown');
    assert.deepEqual(run.engineInfo(), nvenc);
  }

  // ── Local fails, rescue reports unsupported → still the local error
  {
    const localFailure = new ServerRenderError(new Error('local render failed'));
    const run = harness({
      route: plan('server'),
      server: async () => { throw localFailure; },
      browser: async () => ({ status: 'unsupported', reason: BROWSER_ENCODER_UNSUPPORTED_REASON, issues: [] }),
    });
    await assert.rejects(createVideoExporter(run.context)(), (error: unknown) => error === localFailure);
  }

  // ── Local fails and the browser was refused up front → no rescue attempt
  {
    const localFailure = new ServerRenderError(new Error('local render failed'));
    const run = harness({
      route: plan('server', { status: 'unsupported', reason: BROWSER_ENCODER_UNSUPPORTED_REASON, issues: [] }),
      server: async () => { throw localFailure; },
      browser: async () => { throw new Error('must not run'); },
    });
    await assert.rejects(createVideoExporter(run.context)(), (error: unknown) => error === localFailure);
    assert.equal(run.browserCalls(), 0);
  }

  // ── Cancelling during the rescue stays a cancellation
  {
    const run = harness({
      route: plan('server'),
      server: async () => { throw new ServerRenderError(new Error('local render failed')); },
      browser: async () => { throw new DOMException('cancelled', 'AbortError'); },
    });
    await assert.rejects(createVideoExporter(run.context)(),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  }

  // ── A rescue that renders still delivers the file
  {
    const run = harness({
      route: plan('server'),
      server: async () => { throw new ServerRenderError(new Error('local render failed')); },
      browser: async () => ({ status: 'rendered', blob: new Blob(['mp4']), issues: [] }),
    });
    await createVideoExporter(run.context)();
    assert.equal(run.writes(), 1);
    assert.equal(run.renderEngine(), 'browser');
  }
} finally {
  console.warn = originalWarn;
}

console.log('videoExportFallback.verify: neutral browser→local notices and local errors surfaced OK');
