import assert from 'node:assert/strict';
import { parseToolFailures, toolFailureNoteText } from './toolFailureNote';

assert.deepEqual(parseToolFailures(undefined), []);
assert.deepEqual(parseToolFailures([{ name: ' probe_media ', reason: ' e2b sandbox is not configured ' }, { name: '', reason: 'x' }, 'junk', { name: 'a' }]),
  [{ name: 'probe_media', reason: 'e2b sandbox is not configured' }], 'malformed entries are dropped, strings trimmed');

assert.equal(toolFailureNoteText([]), '', 'nothing to say when nothing failed');
const note = toolFailureNoteText([
  { name: 'probe_media', reason: 'no unique asset / path / url for "nope-123"' },
  { name: 'edit_item', reason: 'x'.repeat(400) },
]);
assert.match(note, /^本轮有 2 个工具调用失败，模型已据此作答：probe_media: no unique asset/);
assert.match(note, /；edit_item: x{159}…$/, 'long reasons are clipped');
assert.doesNotMatch(note, /couldn't complete|No success was recorded/, 'the old failure template is gone for good');

console.log('toolFailureNote.verify: parse and note text ok');
