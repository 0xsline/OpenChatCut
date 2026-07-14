// Runnable source-contract check: `npx tsx src/agent/design-tools.check.ts`.
// Covers manage_design_style: preset list/apply, custom designSpec (array +
// legacy role-keyed object → source yM/xM normalizers), update patch, clear.
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import type { TimelineState } from '../editor/types';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from './context';
import { execDesignTool } from './design-tools';
import { DESIGN_STYLE_PRESETS } from '../editor/design-presets';

const state: TimelineState = { fps: 30, width: 1920, height: 1080, selectedId: null, items: [] };
const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, templates: [], audio: [] };

// list returns the built-in preset library
const list = await execDesignTool('manage_design_style', { action: 'list' }, ctx) as { presetId: string }[];
assert.strictEqual(list.length, DESIGN_STYLE_PRESETS.length);

// get is empty before anything is applied
assert.deepStrictEqual(await execDesignTool('manage_design_style', { action: 'get' }, ctx), { designStyle: null });

// apply a preset → project brand is set
await execDesignTool('manage_design_style', { action: 'apply', presetId: 'noir-gold' }, ctx);
assert.strictEqual(draft.getDoc().designStyle?.colors.find((c) => c.role === 'background')?.value, '#070707');

// apply a custom designSpec in LEGACY object form → normalized to arrays (source bM/yM/xM)
await execDesignTool('manage_design_style', {
  action: 'apply',
  designSpec: JSON.stringify({ colors: { primary: '#112233', text: '#ffffff' }, fonts: { heading: 'Sora' }, styleGuide: 'clean' }),
}, ctx);
const s1 = draft.getDoc().designStyle!;
assert.strictEqual(s1.colors.find((c) => c.role === 'primary')?.value, '#112233');
assert.strictEqual(s1.fonts.find((f) => f.role === 'heading')?.family, 'Sora');
assert.strictEqual(s1.styleGuide, 'clean');

// apply array form + applyToProject:false → returns style but does NOT mutate project
const dry = await execDesignTool('manage_design_style', {
  action: 'apply', applyToProject: false,
  designSpec: JSON.stringify({ colors: [{ role: 'accent', value: '#ff0000' }] }),
}, ctx) as { applied: boolean };
assert.strictEqual(dry.applied, false);
assert.strictEqual(draft.getDoc().designStyle?.colors.find((c) => c.role === 'accent')?.value, undefined);

// update patches only the named field
await execDesignTool('manage_design_style', { action: 'update', patch: JSON.stringify({ styleGuide: 'updated' }) }, ctx);
assert.strictEqual(draft.getDoc().designStyle?.styleGuide, 'updated');
assert.strictEqual(draft.getDoc().designStyle?.colors.find((c) => c.role === 'primary')?.value, '#112233', 'update keeps other fields');

// invalid role is dropped by the normalizer
await execDesignTool('manage_design_style', {
  action: 'apply', designSpec: JSON.stringify({ colors: [{ role: 'bogus', value: '#000' }, { role: 'text', value: '#eee' }] }),
}, ctx);
assert.deepStrictEqual(draft.getDoc().designStyle?.colors.map((c) => c.role), ['text']);

// empty spec is rejected
assert.ok('error' in (await execDesignTool('manage_design_style', { action: 'apply', designSpec: '{}' }, ctx) as object));

// clear removes the brand
await execDesignTool('manage_design_style', { action: 'clear' }, ctx);
assert.strictEqual(draft.getDoc().designStyle, undefined);

console.log('design-tools.check: ok');
