import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execAutoGradeTool } from './auto-grade-tools';

const clip: TimelineItem = {
  id: 'clip_grade',
  kind: 'video',
  track: 'V1',
  startFrame: 0,
  durationInFrames: 90,
  name: 'grade-me',
  src: '/media/uploads/grade-me.mp4',
};

const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [{
    id: 'asset_g',
    name: 'grade-me.mp4',
    kind: 'video',
    src: '/media/uploads/grade-me.mp4',
    durationInFrames: 90,
  }],
  items: [clip],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
}));

const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  assert.ok(url.includes('/api/auto-grade'), `unexpected fetch ${url}`);
  const body = JSON.parse(String(init?.body ?? '{}')) as { src?: string };
  assert.equal(body.src, '/media/uploads/grade-me.mp4');
  return new Response(JSON.stringify({
    ok: true,
    src: body.src,
    analyzedStartSeconds: 0,
    analyzedDurationSeconds: 3,
    profile: { bitDepth: 8, hdr: false },
    stats: { sampleCount: 5, yMean: 0.35, yRange: 0.5, saturationMean: 0.12 },
    filters: { brightness: 1.05, contrast: 1.06, saturate: 1.02 },
    adjustments: ['lift-exposure', 'increase-contrast', 'increase-saturation'],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

try {
  const analyzed = await execAutoGradeTool(
    'auto_grade',
    { action: 'analyze', itemIds: 'clip_g' },
    ctx,
  ) as {
    ok?: boolean;
    applied?: boolean;
    recommendations?: Array<{ itemId: string; filters: { brightness: number } }>;
  };
  assert.equal(analyzed.ok, true, JSON.stringify(analyzed));
  assert.equal(analyzed.applied, false);
  assert.equal(analyzed.recommendations?.[0]?.itemId, 'clip_grade');
  assert.equal(analyzed.recommendations?.[0]?.filters.brightness, 1.05);
  assert.equal(draft.getState().items[0]?.filters, undefined, 'analyze must not write');

  const applied = await execAutoGradeTool(
    'auto_grade',
    { action: 'apply', itemIds: 'clip_grade' },
    ctx,
  ) as { ok?: boolean; applied?: boolean; appliedCount?: number };
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.applied, true);
  assert.equal(applied.appliedCount, 1);
  assert.equal(draft.getState().items[0]?.filters?.brightness, 1.05);
  assert.equal(draft.getState().items[0]?.filters?.contrast, 1.06);

  const ineligible = await execAutoGradeTool(
    'auto_grade',
    { action: 'analyze', itemIds: 'missing' },
    ctx,
  ) as { error?: string };
  assert.match(ineligible.error ?? '', /no eligible|missing/i);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('auto-grade-tools.verify: ok');
