import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeZoneOverlay } from './SafeZoneOverlay';

const markup = renderToStaticMarkup(<SafeZoneOverlay />);
assert.match(markup, /aria-hidden="true"/);
assert.equal((markup.match(/border:0\.5px dashed/g) ?? []).length, 2);
assert.match(markup, /inset:5%/);
assert.match(markup, /inset:10%/);

console.log('SafeZoneOverlay.verify: editor-only safety guides passed');
