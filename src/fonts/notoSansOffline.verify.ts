import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FONT_CATALOG } from './googleFontCatalog';
import { findLocalFont } from './localFonts';

const googleFontsSource = readFileSync(new URL('./googleFonts.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  googleFontsSource,
  /@remotion\/google-fonts\/NotoSansSC|NotoSansSCWeight/,
  'Noto Sans SC must not start the remote multi-shard Google Fonts loader during export',
);

const localFace = findLocalFont('Noto Sans SC');
assert.ok(localFace, 'Noto Sans SC must resolve to an offline bundled face');
assert.equal(localFace.family, 'Noto Sans SC');
assert.equal(findLocalFont('Noto Sans CJK SC'), localFace, 'the historical English alias must stay compatible');
assert.equal(findLocalFont('思源黑体'), localFace, 'the historical Chinese alias must stay compatible');
assert.match(localFace.files[400] ?? '', /HarmonyOS_Sans_SC_Regular\.woff2$/);
assert.match(localFace.files[700] ?? '', /HarmonyOS_Sans_SC_Bold\.woff2$/);
assert.deepEqual(
  Object.keys(localFace.files).map(Number).sort((a, b) => a - b),
  [400, 700],
  'the compatibility face must expose the bundled regular and bold variants',
);

const catalogEntries = FONT_CATALOG.filter((entry) => entry.family === 'Noto Sans SC');
assert.equal(catalogEntries.length, 1, 'the font catalog must not expose duplicate remote and local entries');
assert.equal(catalogEntries[0]?.source, 'bundled', 'the font picker must report the offline source truthfully');

console.log('notoSansOffline.verify: Noto Sans SC exports use bundled CJK bytes');
