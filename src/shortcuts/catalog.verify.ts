// Stable regression for the shortcut catalog (count, chord parsing, matcher routing).
// Wired into verify:shortcuts (npm pretest).
import assert from 'node:assert';
import { SHORTCUT_CATALOG, SHORTCUT_BY_ID } from './catalog';
import { matchShortcut, normalizeKey, parseBindingAlts, parseChord } from './match';

assert.strictEqual(SHORTCUT_CATALOG.length, 56);
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

// Every row must also be reachable through the chord it advertises, on both
// platforms: the Ctrl + E / Ctrl + R rows matched nothing off Mac (issue #202).
const ARROW_KEY: Record<string, string> = {
  arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
};
for (const isMac of [true, false]) {
  for (const action of SHORTCUT_CATALOG) {
    for (const chord of parseBindingAlts(action.keys)) {
      const resolved = matchShortcut(
        keyN({
          key: ARROW_KEY[chord.key] ?? (chord.key === 'space' ? ' ' : chord.key),
          shiftKey: chord.shift,
          altKey: chord.alt,
          metaKey: chord.mod && isMac,
          ctrlKey: chord.ctrl || (!isMac && chord.mod),
        }),
        catalog,
        { held: new Set(chord.withKey ? [normalizeKey(chord.withKey)] : []), isMac },
      );
      assert.strictEqual(resolved, action.id,
        `"${action.keys}" must dispatch ${action.id} with isMac=${isMac}`);
    }
  }
}

console.log('shortcuts catalog.verify: ok');
