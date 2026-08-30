// Locale dictionaries moved from static imports to a per-locale lazy fetch, so
// t()/tData() now read a table that may not be loaded yet. This pins the lookup
// semantics that were previously inlined in locale.ts, per language:
//   t:     zh → key · en → EN · it → IT then EN · ru → RU only (no EN fallback)
//   tData: zh → ZH_DATA · en → EN_DATA · it → IT_DATA then EN_DATA · ru → EN_DATA
// and the "never go blank" contract while a dictionary is still in flight.
// npx tsx src/i18n/dictRegistry.verify.ts
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'zh', setItem: () => undefined },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: { lang: 'zh-CN' } },
});

const { ensureLocaleDict, setLocale, t, tData } = await import('./locale.ts');
const { localeDicts } = await import('./dictRegistry.ts');
const { EN } = await import('./dict/en');
const { IT } = await import('./dict/it');
const { RU } = await import('./dict/ru');
const { ZH_DATA } = await import('./dict/zh');
const EN_DATA = (await import('./dict/en/templates-data')).default;
const IT_DATA = (await import('./dict/it/templates-data')).default;

/** A key the reference dictionary translates and the compared one does not. */
function onlyIn(has: Record<string, string>, lacks: Record<string, string>): string {
  const key = Object.keys(has).find((k) => !(k in lacks));
  assert.ok(key, 'the fixture needs a key present in one dictionary but not the other');
  return key;
}

// ── in flight: the Chinese original stands in, never an empty string ─────────
{
  setLocale('en');
  const untranslatedYet = t('导出');
  assert.equal(untranslatedYet, '导出',
    'before the dictionary lands, t() returns the Chinese key rather than blank');
  assert.equal(tData('Bar Chart - Annual Sales'), 'Bar Chart - Annual Sales',
    'tData() likewise passes the original through');
}

// ── en ──────────────────────────────────────────────────────────────────────
{
  await ensureLocaleDict('en');
  const key = Object.keys(EN)[0]!;
  assert.equal(t(key), EN[key], 'en reads the English dictionary');
  assert.equal(t('这个键不存在于任何词典'), '这个键不存在于任何词典',
    'an unknown key falls back to the Chinese original');
  const dataKey = Object.keys(EN_DATA)[0]!;
  assert.equal(tData(dataKey), EN_DATA[dataKey], 'en data names read EN_DATA');
}

// ── it: translated keys win, untranslated ones fall back to English ──────────
{
  setLocale('it');
  await ensureLocaleDict('it');
  const italian = Object.keys(IT)[0]!;
  assert.equal(t(italian), IT[italian], 'it prefers the Italian dictionary');
  const englishOnly = onlyIn(EN, IT);
  assert.equal(t(englishOnly), EN[englishOnly], 'it falls back to English, not to Chinese');
  const italianData = Object.keys(IT_DATA)[0]!;
  assert.equal(tData(italianData), IT_DATA[italianData], 'it prefers IT_DATA');
  // IT_DATA currently covers every EN_DATA key, so no lookup can exercise the
  // data fallback. Assert the wiring instead — the day an English-only data
  // name lands, tData() must already resolve it rather than show Chinese.
  assert.equal(localeDicts('it').dataFallback, EN_DATA,
    'it is wired to fall back to EN_DATA for data names');
}

// ── ru: no English fallback for UI copy, but EN_DATA for data names ──────────
{
  setLocale('ru');
  await ensureLocaleDict('ru');
  const russian = Object.keys(RU)[0]!;
  assert.equal(t(russian), RU[russian], 'ru reads the Russian dictionary');
  const englishOnly = onlyIn(EN, RU);
  assert.equal(t(englishOnly), englishOnly,
    'an untranslated key stays Chinese in ru — it must NOT fall back to English');
  const dataKey = Object.keys(EN_DATA)[0]!;
  assert.equal(tData(dataKey), EN_DATA[dataKey], 'ru data names still read EN_DATA');
}

// ── zh: the key language needs no UI table, only data names ─────────────────
{
  setLocale('zh');
  await ensureLocaleDict('zh');
  const english = Object.keys(EN)[0]!;
  assert.equal(t(english), english, 'zh returns the key verbatim');
  const dataKey = Object.keys(ZH_DATA)[0]!;
  assert.equal(tData(dataKey), ZH_DATA[dataKey], 'zh data names read ZH_DATA');
}

// ── placeholders survive the table swap ─────────────────────────────────────
{
  setLocale('zh');
  assert.equal(t('已选 {n} 项', { n: 3 }), '已选 3 项', 'placeholders are still substituted');
  assert.equal(t('缺少 {missing}', {}), '缺少 {missing}', 'an absent param leaves the placeholder');
}

console.log('dictRegistry.verify: per-locale lazy dictionaries preserve every lookup rule');
