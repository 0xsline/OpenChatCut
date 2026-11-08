import assert from 'node:assert/strict';
import { ASR_MODELS } from '../../../shared/asr-models';
import { EN } from '../../i18n/dict/en';
import { IT } from '../../i18n/dict/it';
import { RU } from '../../i18n/dict/ru';
import { localAsrPage, TRANSCRIPTION_SETTINGS_GROUP } from './settingsMediaProviders';

function transcriptionLanguageOptions(pageFields: readonly { name: string; options?: readonly { value: string; label: string }[] }[]) {
  const field = pageFields.find((candidate) => candidate.name === 'TRANSCRIPTION_LANGUAGE');
  assert.ok(field, 'transcription pages must expose a transcription language selector');
  return field.options ?? [];
}

for (const page of TRANSCRIPTION_SETTINGS_GROUP.vendors) {
  const options = transcriptionLanguageOptions(page.fields);
  for (const language of ['it', 'ru', 'pt']) {
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
assert.ok(
  transcriptionLanguageOptions(localAsrPage.fields).some((option) => option.value === 'pt'),
  'local ASR settings must offer Portuguese transcription',
);

// The Russian UI has no English fallback, so an untranslated language name would show in Chinese.
for (const option of transcriptionLanguageOptions(localAsrPage.fields)) {
  for (const [locale, dict] of [['en', EN], ['it', IT], ['ru', RU]] as const) {
    assert.ok(dict[option.label], `${locale} dictionary must translate ${option.label}`);
  }
}

// Clearing the setting (the "默认（…）" option) falls back to the app locale at
// runtime — see preferredTranscriptionLanguage — so that option must say so
// instead of naming zh, and must be translated where there is no EN fallback.
for (const page of [...TRANSCRIPTION_SETTINGS_GROUP.vendors, localAsrPage]) {
  const field = page.fields.find((candidate) => candidate.name === 'TRANSCRIPTION_LANGUAGE');
  assert.equal(
    field?.defaultLabel,
    '跟随界面语言',
    `${page.key} must describe the runtime default as the UI language`,
  );
  for (const [locale, dict] of [['en', EN], ['it', IT], ['ru', RU]] as const) {
    assert.ok(dict['跟随界面语言'], `${locale} dictionary must translate the locale-following default`);
  }
}

for (const model of ASR_MODELS) {
  assert.match(model.language, /Italian|Italiano|it/i, `${model.id} should be advertised as Italian-capable`);
  assert.match(model.language, /Russian|Русский|ru/i, `${model.id} should be advertised as Russian-capable`);
  assert.match(model.language, /Portuguese|Português/i, `${model.id} should be advertised as Portuguese-capable`);
}

console.log('transcription-language.verify: Italian, Russian and Portuguese transcription are exposed and translated for local and AI providers');
