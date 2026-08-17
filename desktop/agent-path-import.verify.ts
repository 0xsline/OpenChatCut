import assert from 'node:assert/strict';
import { pathAllowedByRoots } from './agent-path-import.ts';

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

console.log('agent-path-import.verify: root whitelist containment passed');
