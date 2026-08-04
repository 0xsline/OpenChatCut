import assert from 'node:assert/strict';
import { resolveInspectorTextAreaRows } from './inspectorTextArea';

assert.equal(resolveInspectorTextAreaRows(''), 1);
assert.equal(resolveInspectorTextAreaRows('One line'), 1);
assert.equal(resolveInspectorTextAreaRows('First\nSecond'), 2);
assert.equal(resolveInspectorTextAreaRows('First\nSecond\nThird'), 2);

console.log('inspectorTextArea.verify: compact text field height passed');
