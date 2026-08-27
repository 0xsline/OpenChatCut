import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from './systemPrompt';
import { isFailedToolResult } from './toolFailure';
import {
  editItemHasFlexCrop,
  guardFlexCropToolLoop,
  noteFlexCropToolResult,
} from './inspect-loop';
import { EDIT_ITEM_TOOL_SCHEMAS } from './tools/schemas/edit-item-tools';
import { FRAMES_TOOL_SCHEMAS } from './tools/schemas/frames-tool';
import { RUN_CODE_TOOL_SCHEMAS } from './tools/schemas/run-code-tools';
import type { AgentContext } from './context';

assert.equal(editItemHasFlexCrop({ updates: [{ transform: { flexCrop: { left: 10 } } }] }), true);
assert.equal(editItemHasFlexCrop({ json: '{"updates":[{"transform":{"crop":{"right":40}}}]}' }), true);
assert.equal(editItemHasFlexCrop({ updates: [{ fromFrame: 0 }] }), false);

{
  const ctx = {} as AgentContext;
  assert.equal(guardFlexCropToolLoop(ctx, 'view_timeline_frames'), null);
  assert.equal(guardFlexCropToolLoop(ctx, 'view_timeline_frames'), null, 'non-crop jobs may look more than once');
  assert.equal(guardFlexCropToolLoop(ctx, 'run_code'), null, 'run_code still allowed until a crop job starts');
}

{
  const ctx = {} as AgentContext;
  const crop = { updates: [{ itemId: 'selected', transform: { crop: { left: 80, right: 80 } } }] };
  assert.equal(guardFlexCropToolLoop(ctx, 'edit_item', crop), null);
  noteFlexCropToolResult(ctx, 'edit_item', crop, { ok: true });
  const recheck = guardFlexCropToolLoop(ctx, 'view_timeline_frames');
  assert.ok(recheck);
  assert.match(recheck.note, /finished|Stop and summarize/i);
  assert.equal(isFailedToolResult(recheck), false);
  const nibble = guardFlexCropToolLoop(ctx, 'edit_item', crop);
  assert.ok(nibble, 'a second successful crop is blocked — one pass is the default');
  assert.ok(guardFlexCropToolLoop(ctx, 'run_code'));
}

{
  const ctx = {} as AgentContext;
  const crop = { updates: [{ transform: { flexCrop: { top: 12 } } }] };
  assert.equal(guardFlexCropToolLoop(ctx, 'edit_item', crop), null);
  noteFlexCropToolResult(ctx, 'edit_item', crop, { error: 'bad id' });
  assert.equal(guardFlexCropToolLoop(ctx, 'edit_item', crop), null, 'failed crop may retry');
  assert.ok(guardFlexCropToolLoop(ctx, 'run_code'), 'run_code blocked once a crop job has started');
}

assert.match(SYSTEM_PROMPT, /does not need to say/i);
assert.match(SYSTEM_PROMPT, /keep only/i);
const editItem = EDIT_ITEM_TOOL_SCHEMAS.find((schema) => schema.name === 'edit_item')!;
assert.match(editItem.description ?? '', /does not need to say/i);
const frames = FRAMES_TOOL_SCHEMAS.find((schema) => schema.name === 'view_timeline_frames')!;
assert.match(frames.description ?? '', /never after/i);
assert.match(RUN_CODE_TOOL_SCHEMAS[0]?.description ?? '', /does not need to forbid/i);

console.log('inspect-loop.verify: one successful crop then stop; extra prompt terms not required');
