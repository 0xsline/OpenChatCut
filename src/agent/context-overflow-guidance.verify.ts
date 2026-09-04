import assert from 'node:assert/strict';
import {
  CONTEXT_OVERFLOW_GUIDANCE_ZH,
  contextOverflowGuidance,
  extractOverflowOriginal,
} from './context-overflow-guidance';

assert.equal(
  contextOverflowGuidance('some unrelated provider error'),
  null,
  'non-overflow errors must pass through untouched',
);
const firstRound = 'The current request is too large for this model context window. Remove large attachments.';
const mapped = contextOverflowGuidance(firstRound);
assert.ok(mapped, 'first-round overflow must map to guidance');
assert.ok(mapped!.startsWith(CONTEXT_OVERFLOW_GUIDANCE_ZH), 'guidance leads, original is retained after it');
assert.ok(mapped!.includes(firstRound), 'the original message must be preserved for diagnostics');
assert.equal(extractOverflowOriginal(mapped!), firstRound, 'the original must round-trip exactly');
const compacted = 'The recent conversation is still too large after context compaction. Start a new chat.';
assert.ok(contextOverflowGuidance(compacted)?.startsWith(CONTEXT_OVERFLOW_GUIDANCE_ZH), 'post-compaction overflow must map too');
assert.equal(extractOverflowOriginal('plain error text'), null, 'plain text has no embedded original');

console.log('context-overflow-guidance.verify: ok');
