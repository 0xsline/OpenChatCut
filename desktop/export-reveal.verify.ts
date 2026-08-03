import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportRevealCandidate, resolveExportRevealTarget } from './export-reveal.ts';

assert.equal(exportRevealCandidate('/tmp/exports', 'demo.mp4'), '/tmp/exports/demo.mp4');
assert.equal(exportRevealCandidate('/tmp/exports', '../demo.mp4'), null, 'filenames must not escape the export directory');
assert.equal(exportRevealCandidate('/tmp/exports', '/tmp/demo.mp4'), null, 'absolute filenames must be rejected');
assert.equal(exportRevealCandidate('relative', 'demo.mp4'), null, 'the export directory must be absolute');

const grantA = 'a'.repeat(43);
const grantB = 'b'.repeat(43);
const destinations: Record<string, string> = {
  [grantA]: '/tmp/exports-a',
  [grantB]: '/tmp/exports-b',
};
let currentDestinationId = grantA;
currentDestinationId = grantB;
const oldRecordTarget = await resolveExportRevealTarget(
  grantA,
  'demo.mp4',
  async (destinationId) => destinations[destinationId] ?? null,
);
assert.equal(currentDestinationId, grantB);
assert.deepEqual(oldRecordTarget, {
  directory: '/tmp/exports-a',
  candidate: '/tmp/exports-a/demo.mp4',
}, 'switching to B must not retarget an A export-history row');
assert.equal(
  await resolveExportRevealTarget(undefined, 'demo.mp4', async () => '/tmp/downloads'),
  null,
  'legacy rows without a proven destination identity must disable reveal',
);

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');
const history = readFileSync(new URL('../src/components/ExportHistory.tsx', import.meta.url), 'utf8');
const english = readFileSync(new URL('../src/i18n/dict/en/components.ts', import.meta.url), 'utf8');
assert.match(main, /openchatcut:reveal-export/, 'Electron main must own the filesystem reveal operation');
assert.match(preload, /revealExport\(destinationId: string, filename: string\)/, 'the preload bridge must expose a narrow identity-bound reveal method');
assert.match(history, /r\.destinationId && window\.openChatCutDesktop\?\.revealExport/, 'legacy and browser rows must not offer reveal');
assert.match(history, /revealExport\(r\.destinationId!, r\.name\)\.catch\(\(\) => undefined\)/, 'history reveal must carry its own destination identity without unhandled rejections');
assert.match(main, /trustedDesktopHandler\(trustedOrigin, async \(/, 'native reveal must remain behind trusted sender validation');
assert.doesNotMatch(main, /restorePersistedExportDirectory\(exportStatePath\) \?\? app\.getPath\('downloads'\)/, 'reveal must never fall back to the current directory or Downloads');
assert.match(english, /'打开文件夹': 'Open Folder'/, 'the new export action must stay localized in English');

console.log('export-reveal.verify: history reveal stays inside the trusted desktop boundary');
