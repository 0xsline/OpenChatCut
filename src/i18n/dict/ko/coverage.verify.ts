// Korean must cover every English UI entry and every data name, and keep the
// {placeholder} set of each entry intact — t() substitutes by name, so a dropped
// or renamed placeholder would leak a raw "{n}" into the UI.
// npx tsx src/i18n/dict/ko/coverage.verify.ts
import assert from 'node:assert/strict';
import { EN } from '../en';
import EN_DATA from '../en/templates-data';
import { ZH_DATA } from '../zh';
import { KO } from './index';
import KO_DATA from './templates-data';

function placeholders(text: string): string {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
}

const missing = Object.keys(EN).filter((key) => !KO[key]?.trim());
assert.deepEqual(missing, [], `Korean dictionary is missing ${missing.length} English keys:\n${missing.join('\n')}`);

const mismatched = Object.entries(KO)
  .filter(([key, korean]) => placeholders(korean) !== placeholders(EN[key] ?? key))
  .map(([key, korean]) => `${key} → ${korean}`);
assert.deepEqual(mismatched, [], `Korean placeholders differ from the source entry:\n${mismatched.join('\n')}`);

// Data names arrive both as Chinese keys (EN_DATA) and English keys (ZH_DATA).
const dataKeys = [...Object.keys(EN_DATA), ...Object.keys(ZH_DATA)];
const missingData = dataKeys.filter((key) => !KO_DATA[key]?.trim());
assert.deepEqual(missingData, [], `Korean data dictionary is missing ${missingData.length} names:\n${missingData.join('\n')}`);

console.log(`ko coverage.verify: ${Object.keys(EN).length} UI keys and ${dataKeys.length} data names covered`);
