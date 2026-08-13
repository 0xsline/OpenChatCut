import assert from 'node:assert/strict';
import { agentAutoApply, setAgentAutoApply } from './approval-mode';

// The auto-apply preference is a per-project composer toggle: defaults to
// ask mode and follows explicit updates. It no longer gates tool execution —
// tools run directly — but the proposal auto-apply behavior still reads it.
assert.equal(agentAutoApply(), false, 'auto-apply defaults to ask mode');
setAgentAutoApply(true);
assert.equal(agentAutoApply(), true, 'the toggle updates the live registry');
setAgentAutoApply(false);
assert.equal(agentAutoApply(), false, 'the toggle restores ask mode');

console.log('approval-mode.verify: preference registry toggle OK');
