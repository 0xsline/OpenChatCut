import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const model = readFileSync(new URL('./useExportDialogModel.ts', import.meta.url), 'utf8');

assert.match(
  model,
  /export const DEFAULT_INCLUDE_MG = true;/,
  'editable-project exports should include rendered motion graphics by default',
);
assert.match(
  model,
  /useState\(DEFAULT_INCLUDE_MG\)/,
  'the dialog state must use the documented default instead of duplicating a literal',
);

console.log('export-reliability.verify: editable-project exports default to complete MG packages');
