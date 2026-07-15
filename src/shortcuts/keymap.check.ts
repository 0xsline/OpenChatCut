// Pure-logic check for the user keymap overlay. localStorage/navigator are absent under
// node — the module guards them (falls back to defaults / non-mac). Run:
//   tsx src/shortcuts/keymap.check.ts
import assert from 'node:assert';
import { SHORTCUT_CATALOG } from './catalog';
import {
  effectiveCatalog, setBinding, resetBinding, resetAllBindings, isCustomized, customizedCount,
  chordFromEvent, findConflicts,
} from './keymap';

const keysOf = (id: string): string => effectiveCatalog().find((a) => a.id === id)!.keys;

resetAllBindings();

// ── default overlay == catalog ──
assert.equal(customizedCount(), 0, 'no overrides initially');
assert.equal(keysOf('undo'), SHORTCUT_CATALOG.find((a) => a.id === 'undo')!.keys, 'undo default');

// ── override + persistence-shape + reset ──
setBinding('undo', 'Mod + Y');
assert.equal(keysOf('undo'), 'Mod + Y', 'override applied');
assert.equal(isCustomized('undo'), true, 'marked customized');
assert.equal(customizedCount(), 1, 'one override');
// unrelated action untouched
assert.equal(keysOf('play-pause'), 'Space', 'others unchanged');
resetBinding('undo');
assert.equal(keysOf('undo'), SHORTCUT_CATALOG.find((a) => a.id === 'undo')!.keys, 'reset restores default');
assert.equal(customizedCount(), 0, 'override cleared');

// ── chordFromEvent — node reports navigator.platform "MacIntel", so this runs as Mac
// (matching the user's darwin): Mod = Cmd (metaKey); Ctrl is a distinct modifier. ──
const ev = (o: Partial<KeyboardEvent>) => ({ key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;
assert.equal(chordFromEvent(ev({ key: 'z', metaKey: true })), 'Mod + Z', 'cmd+z → Mod + Z');
assert.equal(chordFromEvent(ev({ key: 'z', metaKey: true, shiftKey: true })), 'Mod + Shift + Z', 'cmd+shift+z');
assert.equal(chordFromEvent(ev({ key: 'z', ctrlKey: true })), 'Ctrl + Z', 'mac: ctrl is distinct from Mod');
assert.equal(chordFromEvent(ev({ key: 'k', altKey: true })), 'Alt + K', 'alt+k');
assert.equal(chordFromEvent(ev({ key: ' ' })), 'Space', 'space');
assert.equal(chordFromEvent(ev({ key: 'ArrowLeft' })), '←', 'arrow');
assert.equal(chordFromEvent(ev({ key: 'Shift', shiftKey: true })), null, 'bare modifier → null');
assert.equal(chordFromEvent(ev({ key: 'Escape' })), null, 'escape → null');

// ── conflict detection: another action bound to undo's chord conflicts with undo ──
const conflicts = findConflicts(SHORTCUT_CATALOG, 'play-pause', SHORTCUT_CATALOG.find((a) => a.id === 'undo')!.keys);
assert.ok(conflicts.some((c) => c.id === 'undo'), 'Mod+Z conflicts with undo');
// self is never a conflict
assert.ok(!findConflicts(SHORTCUT_CATALOG, 'undo', 'Mod + Z').some((c) => c.id === 'undo'), 'self excluded');
// a free chord has no conflicts
assert.equal(findConflicts(SHORTCUT_CATALOG, 'undo', 'Mod + Alt + Shift + Y').length, 0, 'free chord clean');

resetAllBindings();
console.log('keymap.check.ts OK');
