import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { __resetCaptionPresetMemory } from '../../captions/presetStore';
import { CAPTIONS_TOOL_SCHEMAS } from './schemas/captions-tools';
import { execCaptionsTool } from './captions-tools';

const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1_920,
  height: 1_080,
  selectedId: null,
  assets: [],
  items: [],
  trackOrder: ['C1'],
  tracks: { C1: { kind: 'caption' } },
  captions: { enabled: true, template: 'plain', pacing: 'phrase' },
}));
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const schema = CAPTIONS_TOOL_SCHEMAS.find((tool) => tool.name === 'edit_captions')!;
const actionSchema = schema.input_schema.properties?.action as { enum?: string[] };
const motionSchema = schema.input_schema.properties?.motionPreset as { enum?: string[] };
assert.ok(actionSchema.enum?.includes('animation'));
assert.deepEqual(motionSchema.enum, ['none', 'fade-up', 'pop', 'word-pop', 'karaoke-pulse']);

for (const motionPreset of motionSchema.enum ?? []) {
  const result = await execCaptionsTool('edit_captions', { action: 'animation', motionPreset }, ctx) as {
    ok?: boolean;
    motionPreset?: string;
  };
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.motionPreset, motionPreset);
  assert.equal(draft.getState().captions?.motionPreset, motionPreset);
}

const beforeInvalid = draft.getDoc();
const invalid = await execCaptionsTool(
  'edit_captions',
  { action: 'animation', motionPreset: 'spin-forever' },
  ctx,
) as { error?: string };
assert.match(invalid.error ?? '', /animation needs motionPreset/);
assert.deepEqual(draft.getDoc(), beforeInvalid, 'invalid motion must not mutate the project');

const read = await execCaptionsTool('read_captions', {}, ctx) as { motionPreset?: string };
assert.equal(read.motionPreset, 'karaoke-pulse');

__resetCaptionPresetMemory();
await execCaptionsTool('edit_captions', { action: 'animation', motionPreset: 'pop' }, ctx);
const saved = await execCaptionsTool(
  'edit_captions',
  { action: 'preset_save', presetName: 'motion look' },
  ctx,
) as { presetId?: string };
assert.ok(saved.presetId);
await execCaptionsTool('edit_captions', { action: 'animation', motionPreset: 'none' }, ctx);
await execCaptionsTool('edit_captions', { action: 'preset_apply', presetId: saved.presetId }, ctx);
assert.equal(draft.getState().captions?.motionPreset, 'pop', 'saved caption looks include motion');

console.log('caption-animation.verify: Agent motion action and preset persistence passed');
