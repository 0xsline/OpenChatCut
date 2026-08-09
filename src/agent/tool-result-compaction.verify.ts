import assert from 'node:assert/strict';
import {
  compactToolResultForModel,
  compactToolResultForTransport,
} from './tool-result-compaction';
import { codexToolHistoryEntry } from './codex/tool-history';


const small = { ok: true, items: [{ id: 'a' }] };
assert.equal(compactToolResultForModel(small), small);
const large = {
  items: Array.from({ length: 200 }, (_, index) => ({
    id: `item-${index}`,
    transcript: '字'.repeat(2_000),
  })),
};
const compacted = compactToolResultForModel(large);
const compactedText = JSON.stringify(compacted);
assert.ok(compactedText.length <= 16_000, `compacted result is ${compactedText.length} chars`);
assert.match(compactedText, /truncatedForModel/);
assert.match(compactedText, /item-0/);
assert.equal(JSON.stringify(large).includes('item-199'), true, 'source result remains unchanged');

const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
const shared = { value: 'same reference' };
const unsupported = [
  undefined,
  cyclic,
  { count: 1n },
  () => 'function',
  Symbol('symbol'),
  { first: shared, second: shared },
];
for (const value of unsupported) {
  assert.equal(typeof JSON.stringify(compactToolResultForModel(value)), 'string');
}

const base64 = 'a'.repeat(40_000);
const imageResult = compactToolResultForTransport({
  note: 'x'.repeat(40_000),
  __images: [{ frame: 1, base64 }],
}, true) as { __images: Array<{ base64: string }> };
assert.equal(imageResult.__images[0]?.base64, base64, 'Codex image bytes must remain unchanged');
const exactSkillPage = '中文🙂'.repeat(8_000);
const skillHistory = codexToolHistoryEntry(
  { name: 'load_skill', args: { name: 'fixture' } },
  { success: true, result: { contents: { 'SKILL.md': exactSkillPage }, nextOffset: 32_000 } },
);
assert.equal(typeof skillHistory.content, 'string');
assert.ok(
  (skillHistory.content as string).includes(exactSkillPage),
  'Codex history keeps the exact budgeted load_skill page instead of compacting it again',
);
assert.doesNotMatch(skillHistory.content as string, /truncatedForModel/);


console.log('tool result compaction checks passed');
