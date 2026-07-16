// track-progress-targets.check.ts — source-parity surface of track_progress:
// the schema extender advertises all four source targets with required=['action'],
// and upload (synchronous locally) / visual-analysis (not modeled) answer with
// structured results instead of errors.
//   npx tsx src/agent/track-progress-targets.check.ts
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { withSourceTargets, execUploadProgress, execVisualAnalysisProgress } from './track-progress-parity';
import { makeDraft } from '../editor/store';
import type { TimelineState } from '../editor/types';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from './context';

// ── schema surface matches the source tool (mcp-tools-schema.json) ──
const base: Anthropic.Tool = {
  name: 'track_progress',
  description: 'Inspect or wait for asynchronous generation jobs.',
  input_schema: {
    type: 'object',
    properties: { action: { type: 'string' }, target: { type: 'string', enum: ['generation'] } },
    required: ['action', 'target', 'jobIds'],
  },
};
const other: Anthropic.Tool = { name: 'submit_music', description: 'x', input_schema: { type: 'object', properties: {} } };
const [extended, untouched] = withSourceTargets([base, other]);
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
doc.assets = [{ id: 'asset_up1', kind: 'video', name: 'clip', src: '/media/uploads/x.mp4' } as (typeof doc.assets)[number]];
const draft = makeDraft(doc);
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

const up = execUploadProgress({ action: 'status', target: 'upload', assetIds: 'asset_up, nope' }, ctx) as
  { ok: boolean; target: string; assets?: { assetId: string; status: string }[] };
assert.equal(up.ok, true, 'upload target answers ok');
assert.equal(up.assets?.[0]?.assetId, 'asset_up1', 'prefix resolves to the pool asset');
assert.equal(up.assets?.[0]?.status, 'succeeded', 'synchronous upload reported succeeded');
assert.equal(up.assets?.[1]?.status, 'not_found', 'unknown id reported not_found');
const upBare = execUploadProgress({ action: 'status' }, ctx) as { ok: boolean; assets?: unknown };
assert.equal(upBare.ok, true, 'no assetIds → general note, still ok');
assert.equal(upBare.assets, undefined, 'no per-asset list when none queried');

const va = execVisualAnalysisProgress() as { unsupported: boolean; note: string };
assert.equal(va.unsupported, true, 'visual-analysis is an honest structured unsupported');
assert.ok(va.note.includes('view_asset_frames'), 'points at the working alternative');

console.log('track-progress-targets.check: ok');
