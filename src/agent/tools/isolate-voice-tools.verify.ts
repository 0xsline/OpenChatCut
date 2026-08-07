import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import { activeEditorState, activeTimeline, type MediaAsset, type ProjectDoc } from '../../editor/types.ts';
import { historyReduce, type History } from '../../editor/reduce.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { execIsolateVoiceTool, ISOLATE_VOICE_TOOL_SCHEMAS } from './isolate-voice-tools.ts';

const assets: MediaAsset[] = [
  {
    id: 'asset_source_voice_001', name: 'Interview', kind: 'video', src: '/media/uploads/interview.mp4',
    durationInFrames: 300, width: 1920, height: 1080,
  },
  {
    id: 'asset_source_other_002', name: 'Other source', kind: 'video', src: '/media/uploads/other.mp4',
    durationInFrames: 240, width: 1920, height: 1080,
  },
  {
    id: 'asset_isolated_voice_003', name: 'Interview voice', kind: 'audio', src: '/media/uploads/interview-voice.wav',
    durationInFrames: 300,
  },
  {
    id: 'asset_isolated_voice_004', name: 'Interview voice v2', kind: 'audio', src: '/media/uploads/interview-voice-v2.wav',
    durationInFrames: 300,
  },
  {
    id: 'asset_not_audio_005', name: 'Poster', kind: 'image', src: '/media/uploads/poster.png',
    durationInFrames: 150,
  },
];

const initial: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets,
  mediaFolders: [],
  activeTimelineId: 'timeline_main',
  timelines: [{
    id: 'timeline_main', name: 'Main', order: 0, fps: 30, width: 1920, height: 1080,
    trackOrder: ['track_video'], tracks: { track_video: { kind: 'video' } }, selectedId: null,
    items: [{
      id: 'item_interview_001', track: 'track_video', startFrame: 0, durationInFrames: 150,
      name: 'Interview clip', kind: 'video', src: '/media/uploads/interview.mp4', srcInFrame: 60,
    }],
  }],
};

let history: History = { past: [], present: structuredClone(initial), future: [] };
let denoiseWrites = 0;
const commands = {
  setItemDenoise: (id: string, denoisedSrc: string | null, strength?: number | null) => {
    denoiseWrites += 1;
    history = historyReduce(history, { type: 'setItemDenoise', id, denoisedSrc, strength });
  },
} as EditorCommands;
const ctx = {
  commands,
  getState: () => activeEditorState(history.present),
  getDoc: () => history.present,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
} satisfies AgentContext;

const schema = ISOLATE_VOICE_TOOL_SCHEMAS[0]!;
const properties = schema.input_schema.properties as Record<string, Record<string, unknown>>;
assert.deepEqual(properties.action?.enum, ['apply', 'attach', 'clear']);
assert(properties.sourceAssetId);
assert(properties.denoisedAssetId);

const attached = await execIsolateVoiceTool('isolate_voice', {
  action: 'attach',
  itemId: 'item_interview',
  sourceAssetId: 'asset_source_voice',
  denoisedAssetId: 'asset_isolated_voice_003',
  strength: 80,
}, ctx) as Record<string, unknown>;
assert.equal(attached.ok, true);
assert.equal(attached.action, 'attach');
assert.equal(attached.sourceAssetId, 'asset_source_voice_001');
assert.equal(attached.denoisedAssetId, 'asset_isolated_voice_003');
assert.equal(activeTimeline(history.present).items[0]?.denoisedSrc, '/media/uploads/interview-voice.wav');
assert.equal(activeTimeline(history.present).items[0]?.denoiseStrength, 80);
assert.equal(history.past.length, 1);

const duplicate = await execIsolateVoiceTool('isolate_voice', {
  action: 'attach', itemId: 'item_interview', sourceAssetId: 'asset_source_voice',
  denoisedAssetId: 'asset_isolated_voice_003', strength: 80,
}, ctx) as Record<string, unknown>;
assert.equal(duplicate.unchanged, true);
assert.equal(history.past.length, 1, 'duplicate attach must not create a history entry');

const wrongType = await execIsolateVoiceTool('isolate_voice', {
  action: 'attach', itemId: 'item_interview', sourceAssetId: 'asset_source_voice',
  denoisedAssetId: 'asset_not_audio_005',
}, ctx) as Record<string, unknown>;
assert.match(String(wrongType.error), /必须是 audio/);
assert.equal(history.past.length, 1);

const wrongSource = await execIsolateVoiceTool('isolate_voice', {
  action: 'attach', itemId: 'item_interview', sourceAssetId: 'asset_source_other_002',
  denoisedAssetId: 'asset_isolated_voice_004',
}, ctx) as Record<string, unknown>;
assert.match(String(wrongSource.error), /来源不匹配/);
assert.equal(history.past.length, 1);

const replacement = await execIsolateVoiceTool('isolate_voice', {
  action: 'attach', itemId: 'item_interview', sourceAssetId: 'asset_source_voice_001',
  denoisedAssetId: 'asset_isolated_voice_004', strength: 55,
}, ctx) as Record<string, unknown>;
assert.equal(replacement.ok, true);
assert.equal(activeTimeline(history.present).items[0]?.denoisedSrc, '/media/uploads/interview-voice-v2.wav');
assert.equal(history.past.length, 2);

const assetCount = history.present.assets.length;
const cleared = await execIsolateVoiceTool('isolate_voice', {
  action: 'clear', itemId: 'item_interview',
}, ctx) as Record<string, unknown>;
assert.equal(cleared.ok, true);
assert.equal(activeTimeline(history.present).items[0]?.denoisedSrc, null);
assert.equal(history.present.assets.length, assetCount, 'clear must not remove shared media assets');
assert.equal(history.past.length, 3);

history = historyReduce(history, { type: 'undo' });
assert.equal(activeTimeline(history.present).items[0]?.denoisedSrc, '/media/uploads/interview-voice-v2.wav');
assert.equal(activeTimeline(history.present).items[0]?.denoiseStrength, 55);
history = historyReduce(history, { type: 'redo' });
assert.equal(activeTimeline(history.present).items[0]?.denoisedSrc, null);
assert.equal(history.present.assets.length, assetCount);

const clearAgain = await execIsolateVoiceTool('isolate_voice', {
  action: 'clear', itemId: 'item_interview',
}, ctx) as Record<string, unknown>;
assert.equal(clearAgain.ok, true);
assert.match(String(clearAgain.note), /本来就没有/);
assert.equal(history.past.length, 3);

const originalFetch = globalThis.fetch;
try {
  const pending: {
    body?: { src?: string; sourceRevision?: string };
    settle?: (response: Response) => void;
  } = {};
  globalThis.fetch = ((_input, init) => new Promise<Response>((resolve) => {
    pending.body = JSON.parse(String(init?.body ?? '{}')) as { src?: string; sourceRevision?: string };
    pending.settle = resolve;
  })) as typeof fetch;

  const writesBeforeRelink = denoiseWrites;
  const staleRequest = execIsolateVoiceTool('isolate_voice', {
    action: 'apply',
    itemId: 'item_interview',
    strength: 75,
  }, ctx) as Promise<Record<string, unknown>>;
  const pendingBody = pending.body;
  const settlePending = pending.settle;
  assert(pendingBody, 'apply must submit the isolation request before waiting');
  assert(typeof pendingBody.sourceRevision === 'string');
  assert(settlePending);

  history = historyReduce(history, {
    type: 'pool.relinkAsset',
    id: 'asset_source_voice_001',
    src: '/media/uploads/interview-relinked.mp4',
    sourceRevision: 'source-relinked-during-isolation',
  });
  const historyEntriesAfterRelink = history.past.length;
  settlePending(Response.json({
    path: '/media/uploads/interview-stale-denoised.wav',
    sourceRevision: pendingBody.sourceRevision,
    bytes: 321,
    engine: 'ffmpeg-open-box',
  }));

  const stale = await staleRequest;
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'item_source_changed');
  assert.equal(stale.sourceRevision, pendingBody.sourceRevision);
  assert.equal(stale.currentSourceRevision, 'source-relinked-during-isolation');
  assert.equal(stale.resultSourceRevision, pendingBody.sourceRevision);
  assert.equal('denoisedSrc' in stale, false, 'stale result must discard the derived URL');
  assert.equal(denoiseWrites, writesBeforeRelink, 'relink during isolation must skip setItemDenoise');
  assert.equal(history.past.length, historyEntriesAfterRelink, 'stale completion must not create history');
  assert.equal(activeTimeline(history.present).items[0]?.denoisedSrc, undefined);

  const successfulBody: { value?: { src?: string; sourceRevision?: string } } = {};
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { src?: string; sourceRevision?: string };
    successfulBody.value = body;
    return Response.json({
      path: '/media/uploads/interview-relinked-denoised.wav',
      sourceRevision: body.sourceRevision,
      bytes: 654,
      engine: 'ffmpeg-open-box',
    });
  }) as typeof fetch;

  const successful = await execIsolateVoiceTool('isolate_voice', {
    action: 'apply',
    itemId: 'item_interview',
    strength: 65,
  }, ctx) as Record<string, unknown>;
  assert.equal(successful.ok, true, 'unchanged source during the request must still commit');
  assert.equal(successfulBody.value?.src, '/media/uploads/interview-relinked.mp4');
  assert.equal(successful.sourceRevision, successfulBody.value?.sourceRevision);
  assert.equal(activeTimeline(history.present).items[0]?.denoisedSrc, '/media/uploads/interview-relinked-denoised.wav');
  assert.equal(activeTimeline(history.present).items[0]?.denoiseStrength, 65);
  assert.equal(denoiseWrites, writesBeforeRelink + 1);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('isolate voice attach and stale apply checks passed');
