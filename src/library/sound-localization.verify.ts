import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOUND_EFFECTS } from '../audio/soundLibrary';
import { ZH_DATA } from '../i18n/dict/zh';

const missingNames = SOUND_EFFECTS
  .map((sound) => sound.name)
  .filter((name) => !ZH_DATA[name]);

assert.deepEqual(
  missingNames,
  [],
  'every built-in sound effect must have a Chinese display name',
);

const browserSource = readFileSync(new URL('./SoundBrowser.tsx', import.meta.url), 'utf8');

assert.match(browserSource, /tData\(s\.name\)/, 'Chinese sound names must participate in search');
assert.match(browserSource, /const displayName = tData\(sound\.name\)/, 'sound rows must derive a localized display name');
assert.match(browserSource, /cc-sound-name[^>]*>\{displayName\}/, 'sound rows must render the localized display name');

assert.match(
  browserSource,
  /function toAsset[\s\S]*?name: s\.name/,
  'adding a sound must preserve its canonical data name',
);
assert.match(
  browserSource,
  /setLibraryDrag\([\s\S]*?name: sound\.name/,
  'dragging a sound must preserve its canonical data name',
);

console.log(`sound-localization.verify: ${SOUND_EFFECTS.length} built-in sound names localized without mutating data`);
