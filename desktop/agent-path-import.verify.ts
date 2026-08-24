import assert from 'node:assert/strict';
import {
  appendAgentImportRoot,
  importAgentPathsWithGrant,
  pathAllowedByRoots,
} from './agent-path-import.ts';
import type { AgentPathImportResult } from '../shared/directory-import.ts';

// AGENT_IMPORT_ROOTS whitelist semantics: only explicit roots authorize a
// path; prefix look-alikes and siblings must stay outside.
const roots = ['/Volumes/素材盘', '/Users/qinpx/Movies'];

assert.equal(pathAllowedByRoots(roots, '/Volumes/素材盘/20260101/A001.mp4'), true, 'direct child file is allowed');
assert.equal(pathAllowedByRoots(roots, '/Volumes/素材盘/20260101/sub/A002.mp4'), true, 'deep child is allowed');
assert.equal(pathAllowedByRoots(roots, '/Volumes/素材盘'), true, 'the root itself is allowed');
assert.equal(pathAllowedByRoots(roots, '/Users/qinpx/Movies/短片'), true, 'second root child is allowed');
assert.equal(pathAllowedByRoots(roots, '/Volumes/素材盘2/20260101/A001.mp4'), false, 'prefix look-alike sibling is rejected');
assert.equal(pathAllowedByRoots(roots, '/Volumes/其他盘/A.mp4'), false, 'unrelated path is rejected');
assert.equal(pathAllowedByRoots(roots, '/Users/qinpx/Desktop/A.mp4'), false, 'path outside both roots is rejected');
assert.equal(pathAllowedByRoots([], '/Volumes/素材盘/A.mp4'), false, 'empty root list authorizes nothing');
assert.equal(pathAllowedByRoots(roots, '/Volumes/素材盘'), true, 'root boundary itself allowed');

assert.equal(
  appendAgentImportRoot('/Volumes/素材盘', '/Users/qinpx/Movies'),
  '/Volumes/素材盘,/Users/qinpx/Movies',
  'new grants preserve existing roots',
);
assert.equal(
  appendAgentImportRoot('/Volumes/素材盘', '/Volumes/素材盘'),
  '/Volumes/素材盘',
  'granting the same root is idempotent',
);
assert.throws(() => appendAgentImportRoot('', '/Volumes/素材,盘'), /逗号/);

const blocked: AgentPathImportResult = {
  imported: [], unsupportedFiles: [], duplicateCount: 0,
  errors: [{
    path: '/Volumes/素材盘',
    code: 'IMPORT_ROOTS_NOT_CONFIGURED',
    error: '尚未添加本地素材目录',
  }],
};
const imported: AgentPathImportResult = {
  imported: [], unsupportedFiles: [], duplicateCount: 1, errors: [],
};
let runs = 0;
let written = '';
const granted = await importAgentPathsWithGrant({
  paths: ['/Volumes/素材盘'], projectId: 'verify-project', knownHashes: [],
}, {
  runImport: async () => (++runs === 1 ? blocked : imported),
  chooseRoot: async () => '/Volumes/素材盘',
  readRoots: () => '',
  writeRoots: async (value) => { written = value; },
});
assert.equal(runs, 2, 'successful folder selection retries the original import once');
assert.equal(written, '/Volumes/素材盘', 'selected folder is persisted as an import grant');
assert.equal(granted, imported);

runs = 0;
const cancelled = await importAgentPathsWithGrant({
  paths: ['/Volumes/素材盘'], projectId: 'verify-project', knownHashes: [],
}, {
  runImport: async () => { runs += 1; return blocked; },
  chooseRoot: async () => null,
  readRoots: () => '',
  writeRoots: async () => { throw new Error('cancel must not persist'); },
});
assert.equal(runs, 1, 'cancelling the picker leaves the original result untouched');
assert.equal(cancelled, blocked);

console.log('agent-path-import.verify: root containment and interactive grant retry passed');
