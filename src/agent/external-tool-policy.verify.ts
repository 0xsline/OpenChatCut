import assert from 'node:assert/strict';
import { isExternalServerDirectCall } from './external-tool-policy.ts';

assert.equal(isExternalServerDirectCall('edit_captions', { action: 'display_text' }), true);
assert.equal(isExternalServerDirectCall('edit_captions', { action: 'language_mode', mode: 'original' }), true);
assert.equal(isExternalServerDirectCall('edit_captions', { action: 'language_mode', mode: 'translation' }), true);
assert.equal(
  isExternalServerDirectCall('edit_captions', { action: 'language_mode', mode: 'bilingual' }),
  false,
  'language_mode bilingual can reach translation/provider work and must stay browser-confirmed',
);
assert.equal(
  isExternalServerDirectCall('edit_captions', { action: 'bilingual', languageCode: 'en' }),
  false,
  'bilingual can reach translation/provider work and must stay browser-confirmed',
);
assert.equal(isExternalServerDirectCall('edit_captions', { action: 'preset_apply' }), false);
assert.equal(isExternalServerDirectCall('submit_video', {}), false);
