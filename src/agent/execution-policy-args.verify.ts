// effectiveToolInvocationArgs boundary: internal `__` control fields must never
// arrive from the model (prompt injection would bypass the paid-generation
// idempotency + reservation chain). npx tsx src/agent/execution-policy-args.verify.ts
import assert from 'node:assert/strict';
import { EDIT_ITEM_TOOL_SCHEMAS } from './tools/schemas/edit-item-tools';
import { effectiveToolInvocationArgs, validateAgentToolInvocation } from './execution-policy';

{
  const args: Record<string, unknown> = {
    prompt: 'a city at night',
    provider: 'x',
    __rerunGeneration: true,
    __operationId: 'op-forged',
    __rerunOf: 'op-else',
  };
  const effective = effectiveToolInvocationArgs('submit_video', args);
  assert.deepEqual(effective, { prompt: 'a city at night', provider: 'x' },
    'all __-prefixed keys are stripped from model-supplied args');
  assert.equal(args.__rerunGeneration, true, 'input object is not mutated');
}

{
  const clean = { prompt: 'x' };
  assert.equal(effectiveToolInvocationArgs('submit_video', clean), clean,
    'args without control fields pass through by reference');
}

{
  const effective = effectiveToolInvocationArgs('transcribe_track', {
    trackId: 't1',
    __rerunGeneration: true,
  });
  assert.equal('__rerunGeneration' in effective, false,
    'stripping composes with the transcribe_track provider default');
  assert.equal(typeof effective.provider, 'string',
    'transcribe_track still materializes its provider default');
}

{
  // Issue #135: edit_item root-level extras died as bare "/ must NOT have
  // additional properties" — the model never learned WHICH fields to drop.
  const schema = EDIT_ITEM_TOOL_SCHEMAS[0];
  const rejected = validateAgentToolInvocation(
    schema,
    { itemId: 'clip1', operation: 'split', updates: [] },
    EDIT_ITEM_TOOL_SCHEMAS,
  );
  assert.equal(rejected.ok, false, 'root-level extras must still reject the call');
  assert.match(rejected.error, /additional properties: "itemId"/,
    'the first offending field must be named in the error');
  assert.match(rejected.error, /additional properties: "operation"/,
    'every offending field must be named, one error per property');
  assert.equal(rejected.issues.length, 2, 'one issue per extra root property');
}

{
  const schema = EDIT_ITEM_TOOL_SCHEMAS[0];
  const accepted = validateAgentToolInvocation(
    schema,
    { updates: [{ type: 'video', itemId: 'clip1' }] },
    EDIT_ITEM_TOOL_SCHEMAS,
  );
  assert.equal(accepted.ok, true,
    'canonical edit_item calls keep validating unchanged');
}

console.log('execution-policy-args.verify: ok');
