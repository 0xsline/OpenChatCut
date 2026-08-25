import assert from 'node:assert/strict';
import { createExportJobStore } from '../../export/backgroundExportStore';
import {
  agentExportMediaPoolState,
  subscribeAgentExportJobs,
} from '../../export/agentExportTracking';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execExportTool, __resetExportSessionJobs } from './export-tools';
import { execReadProjectTool } from './read-project-tools';

const sourceAsset = {
  id: 'source-long',
  name: 'long-live.mp4',
  kind: 'video' as const,
  src: '/media/uploads/long-live.mp4',
  durationInFrames: 18_000,
  width: 1920,
  height: 1080,
};
const project = docFromTimeline({
  fps: 30,
  width: 1080,
  height: 1920,
  selectedId: null,
  assets: [sourceAsset],
  items: [{
    id: 'source-range',
    name: '产品痛点',
    kind: 'video',
    track: 'V1',
    src: sourceAsset.src,
    sourceAssetId: sourceAsset.id,
    startFrame: 0,
    durationInFrames: 90,
    srcInFrame: 300,
    playbackRate: 2,
  }],
});
project.timelines[0] = { ...project.timelines[0]!, id: 'clip-01', name: '01-产品痛点-3秒-9:16' };
project.activeTimelineId = 'clip-01';
const draft = makeDraft(project);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getProjectId: () => 'project-clips',
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
const storage = new Map<string, string>([[
  'cc.serverRun.project-clips',
  JSON.stringify({ projectId: 'project-clips', runId: 'run-save' }),
]]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});
const store = createExportJobStore();
const unsubscribe = subscribeAgentExportJobs(
  'project-clips',
  store,
  (message) => message,
  { commands: draft.commands, getDoc: draft.getDoc },
);

try {
  __resetExportSessionJobs();
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === '/export/job' && init?.method === 'POST') {
      return Response.json({ renderId: 'render-save' });
    }
    if (target === '/export/job/render-save' && (!init?.method || init.method === 'GET')) {
      return Response.json({
        id: 'render-save',
        status: 'succeeded',
        progress: 100,
        params: {},
        result: {
          assetId: 'derived-video',
          path: '/media/uploads/openchatcut-export-job-derived-video.mp4',
          name: '01-产品痛点.mp4',
          durationSeconds: 3,
          width: 1080,
          height: 1920,
          sizeBytes: 1024,
          sourceStartSeconds: 0,
        },
      });
    }
    if (target === '/export/job/render-save/promote' && init?.method === 'POST') {
      return Response.json({
        assetId: 'derived-video',
        path: '/media/uploads/openchatcut-derived-derived-video.mp4',
        name: '01-产品痛点.mp4',
        durationSeconds: 3,
        width: 1080,
        height: 1920,
        sizeBytes: 1024,
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;

  const submitted = await execExportTool('submit_render_job', {
    format: 'video',
    name: '01-产品痛点.mp4',
    saveToMediaPool: true,
  }, ctx) as { ok?: boolean; renderId?: string; mediaPoolStatus?: string };
  assert.equal(submitted.ok, true);
  assert.equal(submitted.renderId, 'render-save');
  assert.equal(submitted.mediaPoolStatus, 'pending');

  const tracked = await execExportTool('track_export', {
    action: 'wait',
    renderIds: 'render-save',
  }, ctx) as { mediaPoolStatus?: string; mediaAssetId?: string };
  assert.equal(tracked.mediaPoolStatus, 'saved');
  assert.equal(tracked.mediaAssetId, 'derived-video');
  assert.equal(agentExportMediaPoolState('render-save')?.status, 'saved');
  const actions = draft.takeActions();
  assert.equal(actions.filter((action) => action.type === 'addAsset').length, 1,
    'track_export must capture the derived asset in the Agent draft ledger');
  draft.commands.applyDoc(project);
  draft.takeActions();
  assert.equal(draft.getDoc().assets.length, 1, 'simulate a proposal commit that replaced the live document');
  storage.delete('cc.serverRun.project-clips');
  for (let attempt = 0; attempt < 50 && store.getSnapshot().jobs[0]?.progress.phase !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.getSnapshot().jobs[0]?.progress.phase, 'completed');

  const assets = draft.getDoc().assets;
  assert.equal(assets.length, 2, 'the source stays referenced and one derived asset is registered');
  const saved = assets.find((asset) => asset.id === 'derived-video');
  assert.equal(saved?.src, '/media/uploads/openchatcut-derived-derived-video.mp4');
  assert.deepEqual(saved?.props?.openchatcutDerivedFrom, {
    kind: 'sequence-export',
    timelineId: 'clip-01',
    timelineName: '01-产品痛点-3秒-9:16',
    renderId: 'render-save',
    sourceAssetIds: ['source-long'],
    sourceRanges: [{
      itemId: 'source-range',
      sourceAssetId: 'source-long',
      timelineStartFrame: 0,
      timelineEndFrameExclusive: 90,
      sourceStartFrame: 300,
      sourceEndFrameExclusive: 480,
    }],
  });

  const read = await execReadProjectTool('read_project', { view: 'assets', assetId: 'derived-video' }, ctx) as {
    mediaPool?: { assets?: Array<{ derivedFrom?: unknown }> };
  };
  assert.deepEqual(read.mediaPool?.assets?.[0]?.derivedFrom, saved?.props?.openchatcutDerivedFrom);
} finally {
  unsubscribe();
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

console.log('agent export media-pool checks passed');
