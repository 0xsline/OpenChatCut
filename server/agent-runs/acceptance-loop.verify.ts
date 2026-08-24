import assert from 'node:assert/strict';
import {
  acceptanceInstructions,
  createAcceptanceLoop,
  decideAcceptanceAfterTurn,
  recordAcceptedTool,
} from './acceptance-loop';

assert.equal(decideAcceptanceAfterTurn(createAcceptanceLoop(false, 3)).action, 'finish',
  'the opt-in boundary preserves the previous stop behavior');
assert.equal(decideAcceptanceAfterTurn(createAcceptanceLoop(true, 3)).action, 'finish',
  'read-only answers do not start an acceptance loop');

let state = recordAcceptedTool(createAcceptanceLoop(true, 2), 'reversible_edit');
let decision = decideAcceptanceAfterTurn(state);
assert.equal(decision.action, 'continue');
assert.equal(decision.state.iteration, 1);
assert.match(decision.action === 'continue' ? String(decision.message.content) : '', /read_project/);

state = recordAcceptedTool(decision.state, 'read');
decision = decideAcceptanceAfterTurn(state);
assert.equal(decision.action, 'finish');
assert.equal(decision.action === 'finish' ? decision.status : undefined, 'passed',
  'a settled read after the last edit passes acceptance');

state = recordAcceptedTool(createAcceptanceLoop(true, 2), 'persistent_local');
decision = decideAcceptanceAfterTurn(state);
assert.equal(decision.action, 'continue');
state = recordAcceptedTool(decision.state, 'read');
state = recordAcceptedTool(state, 'reversible_edit');
decision = decideAcceptanceAfterTurn(state);
assert.equal(decision.action, 'continue');
assert.equal(decision.state.iteration, 2, 'a later edit invalidates the earlier verification');
decision = decideAcceptanceAfterTurn(decision.state);
assert.equal(decision.action, 'fail', 'the configured pass limit reports an unverified result');

assert.equal(createAcceptanceLoop(true, 999).maxIterations, 3, 'invalid settings use the stable default');
assert.match(acceptanceInstructions(true), /Autonomous acceptance/);
assert.equal(acceptanceInstructions(false), '');
console.log('acceptance-loop.verify: opt-in, verification, invalidation, and limit checks passed');
