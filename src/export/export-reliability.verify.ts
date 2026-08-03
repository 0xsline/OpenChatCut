import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  effectiveIncludeMg,
  suggestedExportFilename,
} from './useExportWorkflow';
import type { UseExportWorkflowOptions } from './exportWorkflowTypes';

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

const zeroMgXml = {
  tab: 'xml',
  base: 'project',
  codec: 'h264',
  subtitleFormat: 'srt',
  nleFormat: 'fcp_xml',
  includeMg: true,
  mgItems: [],
} as unknown as UseExportWorkflowOptions;
assert.equal(effectiveIncludeMg(zeroMgXml.includeMg, zeroMgXml.mgItems), false);
assert.equal(
  suggestedExportFilename(zeroMgXml),
  'project-premiere.fcpxml',
  'zero-MG XML exports must request a single-file picker even when the checkbox defaults on',
);
assert.match(
  model,
  /includeMg: includeAvailableMg, mgItems/,
  'the effective MG flag must also reach XML generation',
);

console.log('export-reliability.verify: editable-project exports default to complete MG packages');
