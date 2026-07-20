// `npx tsx src/persist/sessionPrefs.check.ts`
import assert from 'node:assert';
import {
  clearComposerDraft,
  loadChatAutoApply,
  loadChatMode,
  loadComposerDraft,
  loadPlayhead,
  loadRecentTemplateIds,
  pushRecentTemplateId,
  saveChatAutoApply,
  saveChatMode,
  saveComposerDraft,
  savePlayhead,
} from './sessionPrefs';

// Node has no localStorage — polyfill a tiny Map so the prefs layer is testable.
const mem = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: () => null,
  get length() { return mem.size; },
};

const pid = 'proj_session_test';
mem.clear();

assert.strictEqual(loadComposerDraft(pid), '');
saveComposerDraft(pid, '  帮我剪口播  ');
assert.strictEqual(loadComposerDraft(pid), '  帮我剪口播  ');
clearComposerDraft(pid);
assert.strictEqual(loadComposerDraft(pid), '');

assert.strictEqual(loadChatMode(pid), 'agent');
saveChatMode(pid, 'ask');
assert.strictEqual(loadChatMode(pid), 'ask');
saveChatMode(pid, 'agent');

assert.strictEqual(loadChatAutoApply(pid), false);
saveChatAutoApply(pid, true);
assert.strictEqual(loadChatAutoApply(pid), true);

assert.strictEqual(loadPlayhead(pid), 0);
savePlayhead(pid, 123.7);
assert.strictEqual(loadPlayhead(pid), 123);
savePlayhead(pid, 0);
assert.strictEqual(loadPlayhead(pid), 0);

mem.delete('cc.recentTemplates');
assert.deepStrictEqual(loadRecentTemplateIds(), []);
pushRecentTemplateId('a');
pushRecentTemplateId('b');
pushRecentTemplateId('a');
assert.deepStrictEqual(loadRecentTemplateIds(), ['a', 'b']);

console.log('sessionPrefs.check: ok');
