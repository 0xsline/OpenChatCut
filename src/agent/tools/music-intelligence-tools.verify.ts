import assert from 'node:assert/strict';
import { MUSIC_MODEL_PACK_FINGERPRINTS } from '../../audio/intelligence/analysis';
import { musicAnalysisRef, saveMusicAnalysis } from '../../audio/intelligence/store';
import type { MusicAnalysis } from '../../audio/intelligence/types';
import type { AtomicAction } from '../../editor/reduce';
import type { TimelineItem, TimelineState } from '../../editor/types';
import type { AgentContext } from '../context';
import { ASK_MODE_TOOL_SCHEMAS } from '../ask-mode-tools';
import { policyForTool } from '../execution-policy';
import { isFailedToolResult } from '../toolFailure';
import { ToolActivation } from '../tool-activation';
import { TOOL_SCHEMAS } from '../tools';
import {
  buildMusicEditPlan,
  buildMusicImagePlacementPlan,
  buildMusicSplitActions,
  execMusicIntelligenceTool,
  staleMusicAnalysisResult,
  MAX_MUSIC_PLAN_CUTS,
  MAX_MUSIC_PLAN_TARGETS,
} from './music-intelligence-tools';

function analysisWith(beatsMs: number[], downbeatsMs: number[] = beatsMs): MusicAnalysis {
  return {
    schemaVersion: 1,
    assetId: 'asset_music',
    sourceRevision: 'sha256:music',
    createdAt: 1,
    durationMs: 180_000,
    modelPacks: { ...MUSIC_MODEL_PACK_FINGERPRINTS },
    bpm: 120,
    meter: 4,
    beatConfidence: 0.9,
    beatsMs,
    downbeatsMs,
    sections: [
      { fromMs: 0, toMs: 30_000, role: 'intro-like', energy: 0.2, boundaryConfidence: 0.8 },
      { fromMs: 30_000, toMs: 180_000, role: 'build', energy: 0.6, boundaryConfidence: 0.9 },
    ],
    tags: [{ kind: 'mood', label: 'energetic', score: 0.91 }],
    embedding: Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0),
  };
}

// ── optional analysis absence must not poison a successful larger Agent run ──
{
  const music = item('optional-music', 'audio', 'A1', 0, 120, {
    src: '/media/uploads/optional.wav',
    sourceAssetId: 'asset_music_optional',
  });
  const ctx = {
    getState: () => state([music]),
    getDoc: () => ({
      schemaVersion: 7,
      assets: [{
        id: 'asset_music_optional', name: 'Optional music', kind: 'audio' as const,
        src: '/media/uploads/optional.wav', durationInFrames: 120,
        sourceRevision: 'sha256:optional',
      }],
    }),
    commands: { batch: () => { throw new Error('must not mutate'); } },
  } as unknown as AgentContext;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    packs: [
      { id: 'rhythm-lite', status: 'absent' },
      { id: 'music-semantics-lite', status: 'absent' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const required = await execMusicIntelligenceTool('analyze_music', { itemId: 'optional-music' }, ctx);
    assert.equal(isFailedToolResult(required), true, 'required analysis keeps strict failure semantics');
    const optional = await execMusicIntelligenceTool(
      'analyze_music',
      { itemId: 'optional-music', optional: true },
      ctx,
    ) as { ok?: boolean; available?: boolean; reason?: string; note?: string };
    assert.equal(optional.ok, true);
    assert.equal(optional.available, false);
    assert.equal(optional.reason, 'analysis-unavailable');
    assert.match(optional.note ?? '', /Install rhythm-lite/);
    assert.equal(isFailedToolResult(optional), false, 'optional unavailable analysis is a successful capability probe');
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function item(
  id: string,
  kind: TimelineItem['kind'],
  track: string,
  startFrame: number,
  durationInFrames: number,
  patch: Partial<TimelineItem> = {},
): TimelineItem {
  return { id, kind, track, startFrame, durationInFrames, name: id, ...patch };
}

function state(items: TimelineItem[], tracks: TimelineState['tracks'] = {}): TimelineState {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    items,
    tracks,
    selectedId: null,
  };
}

{
  const music = item('music', 'audio', 'A1', 100, 300, {
    src: '/media/uploads/music.wav',
    sourceAssetId: 'asset_music',
    srcInFrame: 60,
    playbackRate: 2,
  });
  const video = item('video', 'video', 'V1', 0, 500);
  const built = buildMusicEditPlan(
    analysisWith([4_000]),
    'analysis-ref',
    music,
    state([music, video]),
    { timing: 'beat', density: 'dense' },
  );
  assert.deepEqual(built.plan.cutFrames, [130], 'source 4s maps through srcIn=2s and 2x speed to timeline frame 130');
}

{
  const music = item('music', 'audio', 'A1', 0, 1_200, { src: '/media/uploads/music.wav' });
  const video = item('video', 'video', 'V1', 0, 1_200);
  const beats = Array.from({ length: 40 }, (_, index) => index * 500);
  const timeline = state([music, video]);
  const counts = (['sparse', 'medium', 'dense'] as const).map((density) => (
    buildMusicEditPlan(analysisWith(beats), 'ref', music, timeline, { timing: 'beat', density }).plan.cutFrames.length
  ));
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2], `density must increase cuts deterministically: ${counts}`);
}

{
  const music = item('music', 'audio', 'A1', 0, 120, { src: '/media/uploads/music.wav' });
  const locked = item('locked-video', 'video', 'V1', 0, 120);
  const editable = item('editable-video', 'video', 'V2', 0, 120);
  const timeline = state([music, locked, editable], { V1: { kind: 'video', locked: true }, V2: { kind: 'video' } });
  const built = buildMusicEditPlan(
    analysisWith([1_000, 2_000]),
    'ref',
    music,
    timeline,
    { timing: 'beat', density: 'dense' },
  );
  const prepared = buildMusicSplitActions(built.plan, timeline);
  assert.deepEqual(prepared.lockedIds, ['locked-video']);
  assert.deepEqual(prepared.editableIds, ['editable-video']);
  assert.deepEqual(prepared.actions.map((action) => action.type), ['split', 'split']);
  assert.deepEqual(
    prepared.actions.map((action) => action.type === 'split' ? action.atFrame : -1),
    [60, 30],
    'same original clip must split from right to left inside one batch',
  );
}

{
  assert.deepEqual(staleMusicAnalysisResult('old-ref', 'new-ref'), {
    error: 'stale music analysisRef; call music_edit_plan again before editing',
    staleAnalysisRef: true,
    currentAnalysisRef: 'new-ref',
  });
  assert.equal(staleMusicAnalysisResult('new-ref', 'new-ref'), null);
  assert.equal(staleMusicAnalysisResult(undefined, 'new-ref'), null);
  assert.deepEqual(staleMusicAnalysisResult('old-ref', 'new-ref', 'music_image_plan'), {
    error: 'stale music analysisRef; call music_image_plan again before editing',
    staleAnalysisRef: true,
    currentAnalysisRef: 'new-ref',
  });
}

{
  const music = item('music', 'audio', 'A1', 0, 6_000, { src: '/media/uploads/music.wav' });
  const videos = Array.from({ length: 100 }, (_, index) => item(`video-${index}`, 'video', `V${index}`, 0, 6_000));
  const beats = Array.from({ length: 400 }, (_, index) => index * 250);
  const built = buildMusicEditPlan(
    analysisWith(beats),
    'opaque-ref',
    music,
    state([music, ...videos]),
    { timing: 'beat', density: 'dense' },
  );
  assert.equal(built.plan.cutFrames.length, MAX_MUSIC_PLAN_CUTS);
  assert.equal(built.plan.targetItemIds.length, MAX_MUSIC_PLAN_TARGETS);
  assert.equal(built.plan.analysisRef, 'opaque-ref');
  assert.equal(JSON.stringify(built.plan).includes('embedding'), false, 'plan must never expose CLAP embeddings');
}

{
  const music = item('music', 'audio', 'A1', 0, 120, {
    src: '/media/uploads/music.wav',
    sourceAssetId: 'asset_music',
  });
  const images = [
    {
      id: 'image-a', name: 'A', kind: 'image' as const, src: '/media/uploads/a.png', durationInFrames: 1,
    },
    {
      id: 'image-b', name: 'B', kind: 'image' as const, src: '/media/uploads/b.png', durationInFrames: 1,
    },
  ];
  const built = buildMusicImagePlacementPlan(
    analysisWith([1_000, 2_000, 3_000]),
    'image-plan-ref',
    music,
    state([music], { V1: { kind: 'video' } }),
    images,
    { timing: 'beat', density: 'dense', imageAssetIds: ['image-a', 'image-b'] },
  );
  assert.deepEqual(
    built.plan.placements,
    [
      { assetId: 'image-a', startFrame: 0, durationInFrames: 30 },
      { assetId: 'image-b', startFrame: 30, durationInFrames: 30 },
      { assetId: 'image-a', startFrame: 60, durationInFrames: 30 },
      { assetId: 'image-b', startFrame: 90, durationInFrames: 30 },
    ],
    'photos must occupy beat-to-beat intervals and cycle deterministically',
  );
  assert.throws(
    () => buildMusicImagePlacementPlan(
      analysisWith([1_000, 2_000, 3_000]),
      'image-plan-ref',
      music,
      state([music], { V1: { kind: 'video' } }),
      images,
      { timing: 'beat', density: 'dense', track: 'V99' },
    ),
    /video track "V99" not found/,
    'an invalid explicit target track must not silently fall back to V1',
  );
}

{
  const music = item('music', 'audio', 'A1', 0, 120, {
    src: '/media/uploads/music.wav',
    sourceAssetId: 'asset_music',
  });
  const images = [
    {
      id: 'image-a', name: 'A', kind: 'image' as const, src: '/media/uploads/a.png', durationInFrames: 1,
    },
    {
      id: 'image-b', name: 'B', kind: 'image' as const, src: '/media/uploads/b.png', durationInFrames: 1,
    },
  ];
  const timeline = state([music], { V1: { kind: 'video' } });
  const analysis = analysisWith([1_000, 2_000, 3_000]);
  await saveMusicAnalysis(analysis);
  const batches: Array<{ actions: AtomicAction[]; label?: string }> = [];
  const ctx = {
    getState: () => timeline,
    getDoc: () => ({
      schemaVersion: 7,
      assets: [
        {
          id: 'asset_music', name: 'Music', kind: 'audio' as const,
          src: '/media/uploads/music.wav', durationInFrames: 120, sourceRevision: 'sha256:music',
        },
        ...images,
      ],
    }),
    commands: {
      batch: (actions: AtomicAction[], label?: string) => { batches.push({ actions, label }); },
    },
  } as unknown as AgentContext;
  const stale = await execMusicIntelligenceTool('sync_images_to_music', {
    itemId: 'music',
    timing: 'beat',
    density: 'dense',
    analysisRef: 'old-image-ref',
  }, ctx) as { staleAnalysisRef?: boolean };
  assert.equal(stale.staleAnalysisRef, true);
  assert.equal(batches.length, 0, 'stale analysis must reject before photo mutation');
  const result = await execMusicIntelligenceTool('sync_images_to_music', {
    itemId: 'music',
    timing: 'beat',
    density: 'dense',
    imageAssetIds: ['image-a', 'image-b'],
    analysisRef: musicAnalysisRef(analysis),
  }, ctx) as { changed?: boolean; placementCount?: number };
  assert.equal(result.changed, true);
  assert.equal(result.placementCount, 4);
  assert.equal(batches.length, 1, 'all photo placements must be one EditorCommands batch/undo step');
  assert.deepEqual(
    batches[0]?.actions.map((action) => action.type === 'add'
      ? [action.startFrame, action.item.durationInFrames, action.item.sourceAssetId]
      : null),
    [[0, 30, 'image-a'], [30, 30, 'image-b'], [60, 30, 'image-a'], [90, 30, 'image-b']],
  );
}

{
  const askNames = ASK_MODE_TOOL_SCHEMAS.map((schema) => schema.name);
  assert.ok(askNames.includes('analyze_music'));
  assert.ok(askNames.includes('inspect_music'));
  assert.ok(askNames.includes('music_edit_plan'));
  assert.ok(askNames.includes('music_image_plan'));
  assert.equal(askNames.includes('sync_cuts_to_music'), false, 'Q&A mode must not expose the mutating tool');
  assert.equal(askNames.includes('sync_images_to_music'), false, 'Q&A mode must not expose the mutating photo tool');
  const routed = new ToolActivation(
    TOOL_SCHEMAS,
    [{ role: 'user', content: '请根据 BGM 卡点剪辑这些视频' }],
  ).names();
  assert.ok(routed.includes('analyze_music'));
  assert.ok(routed.includes('inspect_music'));
  assert.ok(routed.includes('music_edit_plan'));
  assert.ok(routed.includes('sync_cuts_to_music'));
  const photoRouted = new ToolActivation(
    TOOL_SCHEMAS,
    [{ role: 'user', content: '按音乐节拍把这些照片卡点排布' }],
  ).names();
  assert.ok(photoRouted.includes('analyze_music'));
  assert.ok(photoRouted.includes('music_image_plan'));
  assert.ok(photoRouted.includes('sync_images_to_music'));
  assert.deepEqual(policyForTool('analyze_music'), { effect: 'read', recovery: 'pure' });
  assert.deepEqual(policyForTool('music_image_plan'), { effect: 'read', recovery: 'pure' });
}


{
  const music = item('music', 'video', 'V1', 0, 120, {
    src: '/media/uploads/music.wav',
    sourceAssetId: 'asset_music',
  });
  const video = item('video', 'video', 'V2', 0, 120);
  const timeline = state([music, video]);
  const analysis = analysisWith([1_000, 2_000]);
  const defaultPlan = buildMusicEditPlan(
    analysis,
    'ref',
    music,
    timeline,
    { timing: 'beat', density: 'dense' },
  );
  assert.deepEqual(
    defaultPlan.plan.targetItemIds,
    ['video'],
    'video clip used as BGM must not target itself when targetItemIds is omitted',
  );
  await saveMusicAnalysis(analysis);
  const batches: Array<{ actions: AtomicAction[]; label?: string }> = [];
  const ctx = {
    getState: () => timeline,
    getDoc: () => ({
      schemaVersion: 7,
      assets: [{
        id: 'asset_music',
        name: 'Music',
        kind: 'video',
        src: '/media/uploads/music.wav',
        durationInFrames: 5_400,
        sourceRevision: 'sha256:music',
      }],
    }),
    commands: {
      batch: (actions: AtomicAction[], label?: string) => { batches.push({ actions, label }); },
    },
  } as unknown as AgentContext;
  const stale = await execMusicIntelligenceTool('sync_cuts_to_music', {
    itemId: 'music',
    timing: 'beat',
    density: 'dense',
    analysisRef: 'old-ref',
  }, ctx) as { staleAnalysisRef?: boolean };
  assert.equal(stale.staleAnalysisRef, true);
  assert.equal(batches.length, 0, 'stale analysis must reject before mutation');
  const missing = await execMusicIntelligenceTool('sync_cuts_to_music', {
    itemId: 'music',
    timing: 'beat',
    density: 'dense',
  }, ctx) as { missingAnalysisRef?: boolean };
  assert.equal(missing.missingAnalysisRef, true);
  assert.equal(batches.length, 0, 'missing analysis ref must reject before mutation');
  const result = await execMusicIntelligenceTool('sync_cuts_to_music', {
    itemId: 'music',
    timing: 'beat',
    density: 'dense',
    analysisRef: musicAnalysisRef(analysis),
    targetItemIds: ['music', 'video'],
  }, ctx) as { changed?: boolean };
  assert.equal(result.changed, true);
  assert.equal(batches.length, 1, 'all music splits must be one EditorCommands batch/undo step');
  assert.equal(batches[0]?.actions.length, 2);
  assert.deepEqual(
    batches[0]?.actions.map((action) => action.type === 'split' ? action.id : null),
    ['video', 'video'],
    'sync must not split the video clip used as BGM even when explicitly targeted',
  );
}
// ── missing model packs → bilingual install guidance in the error ──
{
  const music = item('music', 'video', 'V1', 0, 120, {
    src: '/media/uploads/music.wav',
    sourceAssetId: 'asset_music_missing',
  });
  const timeline = state([music]);
  const ctx = {
    getState: () => timeline,
    getDoc: () => ({
      schemaVersion: 7,
      assets: [{
        id: 'asset_music_missing', name: 'Music', kind: 'video',
        src: '/media/uploads/music.wav', durationInFrames: 5_400,
        sourceRevision: 'sha256:music',
      }],
    }),
    commands: { batch: () => { throw new Error('must not mutate'); } },
  } as unknown as AgentContext;
  const previousFetch = globalThis.fetch;
  const catalogResponse = new Response(JSON.stringify({
    packs: [
      { id: 'rhythm-lite', status: 'absent' },
      { id: 'music-semantics-lite', status: 'absent' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async () => catalogResponse) as typeof fetch;
  try {
    const analysis = analysisWith([1_000], [1_000]);
    await saveMusicAnalysis(analysis);
    const result = await execMusicIntelligenceTool('sync_cuts_to_music', {
      itemId: 'music', timing: 'beat', density: 'dense',
      analysisRef: musicAnalysisRef(analysis),
    }, ctx) as { error?: string; modelPacks?: Array<{ id: string }> };
    assert.ok(result.error, 'missing packs must reject');
    assert.ok(result.error!.includes('设置 → 转写 → 本地模型'), 'error must carry the settings guidance (zh)');
    assert.ok(result.error!.includes('Settings → Transcription → Local models'), 'error must carry the settings guidance (en)');
    assert.equal(result.modelPacks?.length, 2, 'the missing pack ids must be reported');
  } finally {
    globalThis.fetch = previousFetch;
  }
}

// ── music_image_plan builds on the analyze_music pipeline: no implicit analysis ──
{
  const music = item('music', 'audio', 'A1', 0, 120, {
    src: '/media/uploads/music.wav',
    sourceAssetId: 'asset_music_uncached',
  });
  const timeline = state([music], { V1: { kind: 'video' } });
  const ctx = {
    getState: () => timeline,
    getDoc: () => ({
      schemaVersion: 7,
      assets: [
        {
          id: 'asset_music_uncached', name: 'Music', kind: 'audio' as const,
          src: '/media/uploads/music.wav', durationInFrames: 120, sourceRevision: 'sha256:uncached',
        },
      ],
    }),
    commands: { batch: () => { throw new Error('must not mutate'); } },
  } as unknown as AgentContext;
  const previousFetch = globalThis.fetch;
  const catalogResponse = new Response(JSON.stringify({
    packs: [
      { id: 'rhythm-lite', status: 'installed' },
      { id: 'music-semantics-lite', status: 'installed' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async () => catalogResponse) as typeof fetch;
  try {
    const result = await execMusicIntelligenceTool('music_image_plan', {
      itemId: 'music', timing: 'beat', density: 'dense',
    }, ctx) as { error?: string; requiredModelPacks?: string[] };
    assert.ok(result.error, 'a missing cache must reject the plan instead of starting analysis');
    assert.ok(result.error!.includes('not been analyzed'), 'the error must point at the analyze_music entry point');
    assert.deepEqual(result.requiredModelPacks, ['rhythm-lite', 'music-semantics-lite']);
  } finally {
    globalThis.fetch = previousFetch;
  }
}
