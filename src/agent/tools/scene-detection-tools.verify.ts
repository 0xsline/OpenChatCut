import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import type { AtomicAction } from '../../editor/reduce';
import { execSceneDetectionTool } from './scene-detection-tools';

const batches: Array<{ actions: AtomicAction[]; label?: string }> = [];
const item = {
  id: 'item_video',
  track: 'v1',
  startFrame: 100,
  durationInFrames: 180,
  name: 'trimmed speed clip',
  kind: 'video' as const,
  src: '/media/uploads/source.mp4',
  srcInFrame: 60,
  playbackRate: 2,
};
const ctx = {
  getState: () => ({
    fps: 30, width: 1920, height: 1080, items: [item], selectedId: item.id,
    tracks: { v1: { kind: 'video' as const } }, trackOrder: ['v1'],
  }),
  getDoc: () => ({ assets: [{
    id: 'asset_video', name: 'source.mp4', kind: 'video' as const,
    src: item.src, durationInFrames: 600,
  }] }),
  commands: { batch: (actions: AtomicAction[], label?: string) => batches.push({ actions, label }) },
  templates: [], audio: [], getCreativeMode: () => null,
} as unknown as AgentContext;

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
  ok: true,
  durationMs: 20_000,
  threshold: 0.3,
  minSceneMs: 750,
  scenes: [
    { timeMs: 1000, score: 0.7, kind: 'cut' }, // before srcInFrame, filtered
    { timeMs: 4000, score: 0.6, kind: 'cut' }, // local f30 → timeline f130
    { timeMs: 8000, score: 0.35, kind: 'transition' }, // local f90 → f190
  ],
}), { status: 200, headers: { 'content-type': 'application/json' } });

try {
  const marked = await execSceneDetectionTool('detect_scenes', {
    itemId: 'item_', apply: 'markers',
  }, ctx) as { applicableCount: number; appliedCount: number };
  assert.equal(marked.applicableCount, 2);
  assert.equal(marked.appliedCount, 2);
  assert.equal(batches[0]!.label, 'Add scene markers');
  assert.deepEqual(batches[0]!.actions.map((action) => (
    action.type === 'addMarker' ? action.marker.fromFrame : null
  )), [130, 190]);

  const split = await execSceneDetectionTool('detect_scenes', {
    itemId: item.id, apply: 'split',
  }, ctx) as { appliedCount: number };
  assert.equal(split.appliedCount, 2);
  const splitActions = batches[1]!.actions;
  assert.equal(splitActions[0]!.type, 'split');
  assert.equal(splitActions[1]!.type, 'split');
  if (splitActions[0]!.type === 'split' && splitActions[1]!.type === 'split') {
    assert.equal(splitActions[0]!.atFrame, 130);
    assert.equal(splitActions[1]!.id, splitActions[0]!.newId);
    assert.equal(splitActions[1]!.atFrame, 190);
  }
  console.log('scene-detection-tools.check: ok');
} finally {
  globalThis.fetch = originalFetch;
}
