import assert from 'node:assert/strict';

const documentElement = { lang: 'en' };
let persistedLocale = 'it';
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => persistedLocale,
    setItem: (_key: string, value: string) => { persistedLocale = value; },
  },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement },
});

const { getLocale, setLocale } = await import('./locale');
assert.equal(getLocale(), 'it');
assert.equal(persistedLocale, 'it', 'initialization must preserve the saved language');
assert.equal(documentElement.lang, 'it', 'the persisted locale must set the initial document language');
setLocale('zh');
assert.equal(persistedLocale, 'zh');
assert.equal(documentElement.lang, 'zh-CN');

console.log('locale.verify: persisted and changed locales update the document language');
