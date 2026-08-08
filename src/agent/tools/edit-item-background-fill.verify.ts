import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import { makeDraft } from '../../editor/store';
import { applyGeneric, validateGenericUpdate } from './edit-item-generic';
import { execReadProjectTool } from './read-project-tools';
import { EDIT_ITEM_TOOL_SCHEMAS } from './schemas/edit-item-tools';

const item = (id: string, track: string): TimelineItem => ({
  id,
  track,
  kind: 'video',
  name: id,
  src: `/media/uploads/${id}.mp4`,
  startFrame: 0,
  durationInFrames: 60,
  width: 1920,
  height: 1080,
});
const state = {
  fps: 30,
  width: 1080,
  height: 1920,
  selectedId: 'main',
  trackOrder: ['V2', 'V1', 'A1'],
  tracks: { V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items: [item('main', 'V1'), item('overlay', 'V2')],
} as TimelineState;

const valid = validateGenericUpdate(state, {
  type: 'video',
  itemId: 'main',
  backgroundFill: true,
  backgroundFillStrength: 73,
});
assert.equal(valid.error, undefined, String(valid.error));
assert.equal(valid.backgroundFill, true);
assert.equal(valid.backgroundFillStrength, 73);
assert.match(String(validateGenericUpdate(state, {
  type: 'video', itemId: 'main', backgroundFill: 'true',
}).error), /must be a boolean/);
assert.match(String(validateGenericUpdate(state, {
  type: 'video', itemId: 'main', backgroundFillStrength: 101,
}).error), /0 to 100/);
assert.match(String(validateGenericUpdate(state, {
  type: 'video', itemId: 'main', backgroundFillStrength: 73.5,
}).error), /integer/);
const strengthOnly = validateGenericUpdate(state, {
  type: 'video', itemId: 'main', backgroundFillStrength: 87,
});
assert.equal(strengthOnly.backgroundFill, true, 'selecting a percentage enables the fill');
assert.equal(strengthOnly.backgroundFillStrength, 87);
assert.match(String(validateGenericUpdate(state, {
  type: 'video', itemId: 'overlay', backgroundFill: true,
}).error), /bottom video track/);
assert.equal(validateGenericUpdate(state, {
  type: 'video', itemId: 'overlay', backgroundFill: false,
}).backgroundFill, false, 'an invalid historical flag can still be cleared');
assert.equal(validateGenericUpdate(state, {
  type: 'video', itemId: 'overlay', trackId: 'V1', backgroundFill: true,
}).backgroundFill, true, 'one update may move a clip to V1 and enable the fill');

const draft = makeDraft(docFromTimeline(state));
const applied = applyGeneric(valid, draft.commands);
assert.equal(applied?.ok, true);
assert.equal(draft.getState().items.find((entry) => entry.id === 'main')?.backgroundFill, true);
assert.equal(draft.getState().items.find((entry) => entry.id === 'main')?.backgroundFillStrength, 73);

const readResult = await execReadProjectTool('read_project', { view: 'timeline', itemId: 'main' }, {
  getDoc: draft.getDoc,
  getState: draft.getState,
  getProjectId: () => 'background-fill-check',
} as AgentContext) as {
  timeline?: { items?: Array<{ backgroundFill?: boolean; backgroundFillStrength?: number }> };
};
assert.equal(readResult.timeline?.items?.[0]?.backgroundFill, true, 'read_project exposes the applied flag');
assert.equal(readResult.timeline?.items?.[0]?.backgroundFillStrength, 73, 'read_project exposes the exact percentage');

const editItemSchema = EDIT_ITEM_TOOL_SCHEMAS.find((schema) => schema.name === 'edit_item');
const updatesSchema = editItemSchema?.input_schema.properties?.updates as { description?: string } | undefined;
assert.match(String(updatesSchema?.description), /backgroundFillStrength/);

console.log('edit-item-background-fill.verify: validation, EditorCommands apply, schema, and readback ok');
