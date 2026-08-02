import assert from 'node:assert/strict';
import { resolveMediaPoolShortcut } from './mediaPoolShortcutScope';

assert.equal(resolveMediaPoolShortcut({ key: 'a', metaKey: true }), 'select-all');
assert.equal(resolveMediaPoolShortcut({ key: 'c', ctrlKey: true }), 'copy');
assert.equal(resolveMediaPoolShortcut({ key: 'v', metaKey: true }), 'paste');
assert.equal(resolveMediaPoolShortcut({ key: 'Backspace' }), 'delete');
assert.equal(resolveMediaPoolShortcut({ key: 'Escape' }), 'clear-selection');
assert.equal(resolveMediaPoolShortcut({ key: 'a', metaKey: true, shiftKey: true }), null);

console.log('mediaPoolShortcutScope.verify: scoped editing shortcuts resolve predictably');
