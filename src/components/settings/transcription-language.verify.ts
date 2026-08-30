import assert from 'node:assert/strict';
import { ASR_MODELS } from '../../../shared/asr-models';
import { localAsrPage, TRANSCRIPTION_SETTINGS_GROUP } from './settingsMediaProviders';

function transcriptionLanguageOptions(pageFields: readonly { name: string; options?: readonly { value: string; label: string }[] }[]) {
  const field = pageFields.find((candidate) => candidate.name === 'TRANSCRIPTION_LANGUAGE');
  assert.ok(field, 'transcription pages must expose a transcription language selector');
  return field.options ?? [];
}

for (const page of TRANSCRIPTION_SETTINGS_GROUP.vendors) {
  const options = transcriptionLanguageOptions(page.fields);
  for (const language of ['it', 'ru']) {
    assert.ok(
      options.some((option) => option.value === language),
      `${page.key} must offer ${language} transcription`,
    );
  }
}

assert.ok(
  transcriptionLanguageOptions(localAsrPage.fields).some((option) => option.value === 'it'),
  'local ASR settings must offer Italian transcription',
);
assert.ok(
  transcriptionLanguageOptions(localAsrPage.fields).some((option) => option.value === 'ru'),
  'local ASR settings must offer Russian transcription',
);

for (const model of ASR_MODELS) {
  assert.match(model.language, /Italian|Italiano|it/i, `${model.id} should be advertised as Italian-capable`);
  assert.match(model.language, /Russian|Русский|ru/i, `${model.id} should be advertised as Russian-capable`);
}

console.log('transcription-language.verify: Italian and Russian transcription are exposed for local and AI providers');
