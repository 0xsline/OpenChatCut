import assert from 'node:assert/strict';

const documentElement = { lang: 'en' };
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'it', setItem: () => undefined },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement },
});

const { getLocale, setLocale } = await import('./locale');
assert.equal(getLocale(), 'it');
assert.equal(documentElement.lang, 'it', 'the persisted locale must set the initial document language');
setLocale('zh');
assert.equal(documentElement.lang, 'zh-CN');

console.log('locale.verify: persisted and changed locales update the document language');
