import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportRevealCandidate } from './export-reveal.ts';

assert.equal(exportRevealCandidate('/tmp/exports', 'demo.mp4'), '/tmp/exports/demo.mp4');
assert.equal(exportRevealCandidate('/tmp/exports', '../demo.mp4'), null, 'filenames must not escape the export directory');
assert.equal(exportRevealCandidate('/tmp/exports', '/tmp/demo.mp4'), null, 'absolute filenames must be rejected');
assert.equal(exportRevealCandidate('relative', 'demo.mp4'), null, 'the export directory must be absolute');

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');
const history = readFileSync(new URL('../src/components/ExportHistory.tsx', import.meta.url), 'utf8');
const english = readFileSync(new URL('../src/i18n/dict/en/components.ts', import.meta.url), 'utf8');
assert.match(main, /openchatcut:reveal-export/, 'Electron main must own the filesystem reveal operation');
assert.match(preload, /revealExport\(filename: string\)/, 'the preload bridge must expose a narrow reveal method');
assert.match(history, /openChatCutDesktop\?\.revealExport/, 'export history must offer reveal only when desktop support exists');
assert.match(history, /revealExport\(r\.name\)\.catch\(\(\) => undefined\)/, 'a rejected native reveal must not become an unhandled UI rejection');
assert.match(english, /'打开文件夹': 'Open Folder'/, 'the new export action must stay localized in English');

console.log('export-reveal.verify: history reveal stays inside the trusted desktop boundary');
