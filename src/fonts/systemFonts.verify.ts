import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: { getItem: () => '{"invalid":true}', setItem: () => {} }, addEventListener: () => {} },
});
const system = await import('./systemFonts');
const catalog = await import('./googleFontCatalog');
const { FontFamilyPicker } = await import('../components/inspector/FontFamilyPicker');

assert.equal(catalog.isLoadableFontFamily('Gotham'), false, 'suggestions cannot certify installed fonts');
system.registerCustomFont('NeverInstalledFontFixture');
assert.equal(catalog.isLoadableFontFamily('NeverInstalledFontFixture'), false, 'typing a font name cannot bypass fallback consent');
assert.equal(catalog.searchFontCatalog('NeverInstalledFontFixture')[0]?.loadable, false);

const installed = Array.from({ length: 101 }, (_, i) => 'InstalledFont' + String(i).padStart(3, '0'));
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return new Response(JSON.stringify({ ok: true, userFonts: [], systemFonts: installed, allFonts: installed }));
};
await Promise.all([system.refreshSystemFonts(), system.refreshSystemFonts()]);
assert.equal(calls, 1, 'concurrent discovery must share the in-flight request');
assert.equal(catalog.isLoadableFontFamily(installed[100]!), true);
const html = renderToStaticMarkup(createElement(FontFamilyPicker, { value: installed[100]!, onChange: () => {} }));
assert.match(html, /<option[^>]*value="InstalledFont100"[^>]*selected=""/, 'installed fonts after entry 100 must remain selectable');
assert.equal(system.getAllDiscoveredFonts().includes('Gotham'), false);
const urls: string[] = [];
let release!: () => void;
globalThis.fetch = async (url) => {
  urls.push(String(url));
  if (!String(url).includes('refresh=1')) await new Promise<void>((resolve) => { release = resolve; });
  return Response.json({ ok: true, userFonts: [], systemFonts: ['Fresh Installed Font'] });
};
const ordinary = system.refreshSystemFonts();
const forced = system.refreshSystemFonts(true);
release();
await Promise.all([ordinary, forced]);
assert.deepEqual(urls, ['/api/system-fonts', '/api/system-fonts?refresh=1'], 'forced refresh cannot be lost behind a cached request');
console.log('systemFonts.verify: availability, malformed storage, discovery and complete selection passed');
