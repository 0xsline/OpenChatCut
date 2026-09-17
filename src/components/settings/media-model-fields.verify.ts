import assert from 'node:assert/strict';
import { SETTINGS_CATEGORIES, isModelField } from './settingsSchema';
import type { SettingsField } from './settingsFields';

/** Media generation models are free text with suggestions, never a locked
 *  <select>: a vendor model released after the suggestion list was written has
 *  to stay reachable from settings (issue #136). */
const MEDIA_MODEL_FIELDS = [
  'MINIMAX_IMAGE_MODEL',
  'MINIMAX_VIDEO_MODEL',
  'MINIMAX_MUSIC_MODEL',
  'ATLASCLOUD_MUSIC_MODEL',
  'ELEVENLABS_TTS_MODEL',
  'MINIMAX_TTS_MODEL',
  'SPEECHIFY_TTS_MODEL',
] as const;

const byName = new Map<string, SettingsField>();
for (const category of SETTINGS_CATEGORIES) {
  for (const group of category.groups) {
    for (const page of group.vendors) {
      for (const field of page.fields) byName.set(field.name, field);
    }
  }
}

for (const name of MEDIA_MODEL_FIELDS) {
  const field = byName.get(name);
  assert.ok(field, `${name} is missing from the settings schema`);
  assert.equal(field.kind, 'text', `${name} must stay free text so an unlisted model id can be saved`);
  assert.ok(field.options && field.options.length > 0, `${name} lost its suggested model ids`);
  // Dropping defaultLabel would take the field out of the model value channel
  // and stop echoing the model already configured on the server.
  assert.ok(field.defaultLabel, `${name} must keep its default model label`);
  assert.ok(isModelField(field), `${name} must stay on the model value channel`);
  assert.ok(field.note, `${name} must tell the user any model id is accepted`);
}

// Suggestions are model ids, not translated copy.
for (const name of MEDIA_MODEL_FIELDS) {
  for (const option of byName.get(name)?.options ?? []) {
    assert.equal(option.label, option.value, `${name} suggestion ${option.value} must not need translation`);
  }
}

console.log(`mediaModelFields.check: ok (${MEDIA_MODEL_FIELDS.length} media model fields are configurable)`);
