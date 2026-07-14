// Runnable: `npx tsx src/shortcuts/catalog.check.ts`
import assert from 'node:assert';
import { SHORTCUT_CATALOG, SHORTCUT_BY_ID } from './catalog';
import { matchShortcut, parseBindingAlts, parseChord } from './match';

assert.strictEqual(SHORTCUT_CATALOG.length, 54);
assert.ok(SHORTCUT_BY_ID['play-pause']);
assert.ok(SHORTCUT_BY_ID['shuttle-back']);

const space = parseChord('Space');
assert.ok(space);
assert.strictEqual(space!.key, 'space');

const chord = parseChord('Mod + Alt + V');
assert.ok(chord);
assert.strictEqual(chord!.mod, true);
assert.strictEqual(chord!.alt, true);
assert.strictEqual(chord!.key, 'v');

const alts = parseBindingAlts('E / Shift + E');
assert.strictEqual(alts.length, 2);
assert.strictEqual(alts[1]!.shift, true);

// Node has no document — mock target
const fakeTarget = { tagName: 'DIV', isContentEditable: false, closest: () => null } as unknown as HTMLElement;

function keyN(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    shiftKey: !!init.shiftKey,
    altKey: !!init.altKey,
    metaKey: !!init.metaKey,
    ctrlKey: !!init.ctrlKey,
    repeat: false,
    target: fakeTarget,
    preventDefault() {},
  } as unknown as KeyboardEvent;
}

const catalog = SHORTCUT_CATALOG.map((a) => ({ id: a.id, keys: a.keys, disabledWhenTyping: a.disabledWhenTyping }));

assert.strictEqual(
  matchShortcut(keyN({ key: 'v' }), catalog, { held: new Set(), isMac: true }),
  'interaction-mode-selection',
);
assert.strictEqual(
  matchShortcut(keyN({ key: ' ' }), catalog, { held: new Set(), isMac: true }),
  'play-pause',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'ArrowLeft' }), catalog, { held: new Set(), isMac: true }),
  'seek-back',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'ArrowLeft', shiftKey: true }), catalog, { held: new Set(), isMac: true }),
  'seek-back-sec',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'e', shiftKey: true }), catalog, { held: new Set(), isMac: true }),
  'nudge-left',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'j' }), catalog, { held: new Set(), isMac: true }),
  'shuttle-back',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'i' }), catalog, { held: new Set(), isMac: true }),
  'zone-in',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'k', metaKey: true, altKey: true }), catalog, { held: new Set(), isMac: true }),
  'keyboard-shortcuts',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'v', metaKey: true, altKey: true }), catalog, { held: new Set(), isMac: true }),
  'paste-effects',
);
// combo K+J
assert.strictEqual(
  matchShortcut(keyN({ key: 'j' }), catalog, { held: new Set(['k']), isMac: true }),
  'shuttle-jog-back',
);

console.log('shortcuts catalog.check: ok');
