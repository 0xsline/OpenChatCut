import assert from 'node:assert/strict';
import { matchShortcut } from './match';

const copyCatalog = [{ id: 'copy', keys: 'Mod + C' }];

const copyEvent = {
  key: 'c',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  target: null,
} as unknown as KeyboardEvent;

assert.equal(
  matchShortcut(copyEvent, copyCatalog, {
    held: new Set(['c']),
    isMac: true,
    hasTextSelection: true,
  }),
  null,
  'selected interface text must keep the native copy shortcut',
);

assert.equal(
  matchShortcut(copyEvent, copyCatalog, {
    held: new Set(['c']),
    isMac: true,
    hasTextSelection: false,
  }),
  'copy',
  'without a text selection, Mod+C must still copy selected timeline clips',
);

console.log('native copy shortcut verification passed');
