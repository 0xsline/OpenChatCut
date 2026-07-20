import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store.ts';
import type { AgentContext } from '../context.ts';
import type { ProjectDoc, Timeline } from '../../editor/types.ts';
import { execEffectTool } from './effect-tools.ts';

const timeline: Timeline = {
  id: 'tl_effect_response',
  name: 'effect response',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items: [{
    id: 'item_visual',
    kind: 'image',
    name: 'Still',
    src: '/still.jpg',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 90,
  }],
  selectedId: null,
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video', name: 'Video' } },
};
const doc: ProjectDoc = {
  version: 2,
  assets: [],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
const draft = makeDraft(doc);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const added = await execEffectTool('manage_effects', {
  action: 'add',
  targetItemId: 'item_visual',
  assetId: 'builtin:fx-rgb-split',
  propertyOverrides: { amount: 0.2 },
}, ctx) as { effect: { assetId: string; overrides: { amount: number } }; effects: unknown[] };
assert.equal(added.effect.assetId, 'builtin:fx-rgb-split');
assert.equal(added.effect.overrides.amount, 0.2);
assert.equal(added.effects.length, 1);

console.log('effect tool immediate response check passed');
