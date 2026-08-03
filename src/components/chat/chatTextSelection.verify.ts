import assert from 'node:assert/strict';
import {
  resolveChatTextShortcut,
  selectChatMessageContents,
  shouldHandleChatTextSelection,
} from './chatTextSelection';

assert.equal(resolveChatTextShortcut({ key: 'a', metaKey: true, ctrlKey: false, altKey: false }), 'select-all');
assert.equal(resolveChatTextShortcut({ key: 'A', metaKey: false, ctrlKey: true, altKey: false }), 'select-all');
assert.equal(resolveChatTextShortcut({ key: 'a', metaKey: true, ctrlKey: false, altKey: true }), null);
assert.equal(resolveChatTextShortcut({ key: 'c', metaKey: true, ctrlKey: false, altKey: false }), null);

const chatBodyTarget = { closest: () => null } as unknown as HTMLElement;
const inputTarget = { closest: () => ({}) } as unknown as HTMLElement;
const selectAll = { key: 'a', metaKey: true, ctrlKey: false, altKey: false };
assert.equal(shouldHandleChatTextSelection(selectAll, chatBodyTarget), true);
assert.equal(shouldHandleChatTextSelection(selectAll, inputTarget), false);

const element = {} as HTMLElement;
const calls: string[] = [];
const range = {
  selectNodeContents(node: Node) {
    assert.equal(node, element);
    calls.push('select');
  },
} as unknown as Range;
const selection = {
  removeAllRanges() { calls.push('clear'); },
  addRange(candidate: Range) {
    assert.equal(candidate, range);
    calls.push('add');
  },
} as unknown as Selection;

assert.equal(selectChatMessageContents(element, { selection, createRange: () => range }), true);
assert.deepEqual(calls, ['select', 'clear', 'add']);
assert.equal(selectChatMessageContents(null, { selection, createRange: () => range }), false);

console.log('chatTextSelection.verify: chat-only select-all behavior OK');
