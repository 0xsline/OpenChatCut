import assert from 'node:assert/strict';
import { sanitizeFileName } from './file-name.ts';
import { sanitizeFileName as fromServer } from '../server/file-name.ts';

// Built rather than written literally: a raw control character in source is invisible
// in diffs and review, and survives copy/paste badly.
const ctrl = (...codes: number[]) => String.fromCharCode(...codes);

// Forbidden characters collapse to a single underscore per run, not one each.
assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j', 'fallback'), 'a_b_c_d_e_f_g_h_i_j');
assert.equal(sanitizeFileName('a///b', 'fallback'), 'a_b', 'a run of forbidden chars is one underscore');

// Control characters are replaced one for one, so a run of them keeps its length.
assert.equal(sanitizeFileName(`a${ctrl(1, 2)}b`, 'fallback'), 'a__b');
assert.equal(sanitizeFileName('tab\there', 'fallback'), 'tab_here');
assert.equal(sanitizeFileName(`x${ctrl(31)}y`, 'fallback'), 'x_y', '0x1f is the last control char replaced');
assert.equal(sanitizeFileName(`x${ctrl(32)}y`, 'fallback'), 'x y', '0x20 is a space and is kept');

// Unicode survives — the whole point of not falling back to an ASCII allowlist.
assert.equal(sanitizeFileName('导出视频 v2.mp4', 'fallback'), '导出视频 v2.mp4');
assert.equal(sanitizeFileName('café ☕.mov', 'fallback'), 'café ☕.mov');

// The fallback covers every way a name can end up empty.
assert.equal(sanitizeFileName('', 'fallback'), 'fallback');
assert.equal(sanitizeFileName('   ', 'fallback'), 'fallback', 'whitespace-only is empty after trim');
assert.equal(sanitizeFileName(ctrl(1, 2), 'fallback'), '__', 'control chars become characters, not empty');
assert.equal(sanitizeFileName('.', 'fallback'), '.', 'a bare dot is a legal name here');

// Trimming is outer-only: interior spacing is the user's choice.
assert.equal(sanitizeFileName('  spaced name  ', 'fallback'), 'spaced name');

// Both hosts must resolve to this one implementation. If either re-export is ever
// replaced by a second copy, this identity check fails before the two can silently
// disagree about the name the user sees and the name written to disk.
assert.equal(fromServer, sanitizeFileName, 'server/file-name.ts must re-export the shared implementation');

console.log('file name checks passed');
