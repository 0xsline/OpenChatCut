// track-progress-targets.check.ts verifies the track_progress target surface:
// the schema extender advertises all four targets with required=['action'],
// and upload / visual-analysis answer with structured results instead of errors.
//   npx tsx src/agent/progress/track-progress-targets.check.ts
import assert from 'node:assert/strict';
import type { AgentToolSchema } from '../tool-schema';
import { withProgressTargets, execUploadProgress, execVisualAnalysisProgress } from './track-progress-targets';
import { __resetVisualAnalysisJobs } from './visual-analysis-jobs';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';

// ── Schema exposes every supported target ─────────────────────────────────
const base: AgentToolSchema = {
  name: 'track_progress',
  description: 'Inspect or wait for asynchronous generation jobs.',
  input_schema: {
    type: 'object',
    properties: { action: { type: 'string' }, target: { type: 'string', enum: ['generation'] } },
    required: ['action', 'target', 'jobIds'],
  },
};
const other: AgentToolSchema = { name: 'submit_music', description: 'x', input_schema: { type: 'object', properties: {} } };
const [extended, untouched] = withProgressTargets([base, other]);
const input = extended.input_schema as { required?: string[]; properties: Record<string, { enum?: string[] }> };
assert.deepEqual(input.required, ['action'], 'source requires only action');
assert.deepEqual(
  input.properties.target?.enum,
  ['generation', 'transcription', 'upload', 'visual-analysis'],
  'all four source targets advertised',
);
assert.ok(typeof input.properties.assetIds === 'object', 'assetIds param present');
assert.equal(untouched, other, 'non-track_progress tools pass through untouched');
assert.deepEqual((base.input_schema as { required?: string[] }).required, ['action', 'target', 'jobIds'], 'extender is immutable — original schema unchanged');

// ── upload / visual-analysis answer structurally, never throw ──
const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null,
  trackOrder: ['track_v1'], tracks: { track_v1: { kind: 'video' } },
};
const doc = docFromTimeline(state);
doc.assets = [
  { id: 'asset_up1', kind: 'video', name: 'clip', src: '/media/uploads/x.mp4' } as (typeof doc.assets)[number],
  { id: 'asset_lib1', kind: 'audio', name: 'bgm', src: '/audio/track-1.mp3' } as (typeof doc.assets)[number],
];
const draft = makeDraft(doc);
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

const up = await execUploadProgress({ action: 'status', target: 'upload', assetIds: 'asset_up, nope' }, ctx) as
  { ok: boolean; target: string; assets?: { assetId: string; status: string }[] };
assert.equal(up.ok, true, 'upload target answers ok');
assert.equal(up.assets?.[0]?.assetId, 'asset_up1', 'prefix resolves to the pool asset');
// 新占位语义:/media/uploads/ 需探测可达性;check 无服务器 → 诚实报 running(字节未落)
assert.equal(up.assets?.[0]?.status, 'running', 'unreachable upload src reports running (bytes not landed)');
assert.equal(up.assets?.[1]?.status, 'not_found', 'unknown id reported not_found');
const lib = await execUploadProgress({ action: 'status', target: 'upload', assetIds: 'asset_lib' }, ctx) as
  { assets?: { status: string }[] };
assert.equal(lib.assets?.[0]?.status, 'succeeded', 'library/non-upload src needs no upload job');
const upBare = await execUploadProgress({ action: 'status' }, ctx) as { ok: boolean; assets?: unknown };
assert.equal(upBare.ok, true, 'no assetIds → still ok');
assert.equal((upBare.assets as unknown[]).length, 2, 'no assetIds → status of every pool asset');

__resetVisualAnalysisJobs();
const va = await execVisualAnalysisProgress({ action: 'status', target: 'visual-analysis', assetIds: 'asset_up' }, ctx) as {
  ok: boolean;
  target: string;
  assets?: { assetId: string; status: string }[];
  note?: string;
};
assert.equal(va.ok, true, 'visual-analysis answers ok (modeled jobs)');
assert.equal(va.target, 'visual-analysis');
assert.equal(va.assets?.[0]?.assetId, 'asset_up1', 'prefix resolves');
assert.ok(
  va.assets?.[0]?.status === 'running' || va.assets?.[0]?.status === 'succeeded' || va.assets?.[0]?.status === 'failed',
  'status is a real job wire value',
);
assert.ok(va.note?.includes('view_asset_frames'), 'points at frame tools for actual vision');

const vaMissing = await execVisualAnalysisProgress({ action: 'status', assetIds: 'nope' }, ctx) as {
  assets?: { status: string }[];
};
assert.equal(vaMissing.assets?.[0]?.status, 'not_found', 'unknown asset → not_found');

console.log('track-progress-targets.check: ok');
