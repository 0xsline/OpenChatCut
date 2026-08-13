import assert from 'node:assert/strict';
import { agentAutoApply, setAgentAutoApply } from './approval-mode';

// The registry initializes to manual until the composer syncs the persisted
// per-project preference. It drives prompt/proposal behavior, not tool execution.
assert.equal(agentAutoApply(), false, 'the unsynced registry initializes to manual mode');
setAgentAutoApply(true);
assert.equal(agentAutoApply(), true, 'the toggle updates the live registry');
setAgentAutoApply(false);
assert.equal(agentAutoApply(), false, 'the toggle restores ask mode');

console.log('approval-mode.verify: preference registry toggle OK');
