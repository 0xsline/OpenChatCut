// effectiveToolInvocationArgs boundary: internal `__` control fields must never
// arrive from the model (prompt injection would bypass the paid-generation
// idempotency + reservation chain). npx tsx src/agent/execution-policy-args.verify.ts
import assert from 'node:assert/strict';
import { effectiveToolInvocationArgs } from './execution-policy';

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

console.log('execution-policy-args.verify: ok');
