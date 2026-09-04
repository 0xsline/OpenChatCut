import assert from 'node:assert/strict';
import { ensureLocaleDict } from '../i18n/dictRegistry';
import { setLocale, t } from '../i18n/locale';
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
const compacted = 'The recent conversation is still too large after context compaction. Start a new chat.';

// ── zh (default): guidance leads, original retained, round-trip exact ────────
{
  const mapped = contextOverflowGuidance(firstRound);
  assert.ok(mapped, 'first-round overflow must map to guidance');
  assert.ok(mapped!.startsWith(`${t(CONTEXT_OVERFLOW_GUIDANCE_ZH)}\n\n`),
    'guidance leads, original is retained after it');
  assert.ok(mapped!.includes(firstRound), 'the original message must be preserved for diagnostics');
  assert.equal(extractOverflowOriginal(mapped!), firstRound, 'the original must round-trip exactly');
  assert.ok(contextOverflowGuidance(compacted)?.startsWith(t(CONTEXT_OVERFLOW_GUIDANCE_ZH)),
    'post-compaction overflow must map too');
}

// ── en: the guidance follows the current locale and still round-trips ────────
{
  setLocale('en');
  await ensureLocaleDict('en');
  assert.notEqual(t(CONTEXT_OVERFLOW_GUIDANCE_ZH), CONTEXT_OVERFLOW_GUIDANCE_ZH,
    'the en dictionary must translate the overflow guidance');
  const mapped = contextOverflowGuidance(firstRound);
  assert.ok(mapped?.startsWith(t(CONTEXT_OVERFLOW_GUIDANCE_ZH)),
    'en users get the localized guidance, not the Chinese original');
  assert.equal(extractOverflowOriginal(mapped!), firstRound,
    'en-composed overflow messages round-trip too');
  setLocale('zh');
}

assert.equal(extractOverflowOriginal('plain error text'), null, 'plain text has no embedded original');

console.log('context-overflow-guidance.verify: ok');
