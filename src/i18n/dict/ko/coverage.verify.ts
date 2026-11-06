// Every Korean entry must keep the {placeholder} set of its source entry —
// t() substitutes by name, so a dropped or renamed placeholder would leak a raw
// "{n}" into the UI. Missing entries are fine: Korean falls back to English, so
// a new English string or data name does not have to ship with a translation.
// npx tsx src/i18n/dict/ko/coverage.verify.ts
import assert from 'node:assert/strict';
import { EN } from '../en';
import { KO } from './index';

function placeholders(text: string): string {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
}

const mismatched = Object.entries(KO)
  .filter(([key, korean]) => placeholders(korean) !== placeholders(EN[key] ?? key))
  .map(([key, korean]) => `${key} → ${korean}`);
assert.deepEqual(mismatched, [], `Korean placeholders differ from the source entry:\n${mismatched.join('\n')}`);

console.log(`ko coverage.verify: ${Object.keys(KO).length} Korean entries keep their placeholders`);
