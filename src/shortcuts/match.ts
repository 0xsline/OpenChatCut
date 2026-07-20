// Match KeyboardEvent against binding strings such as "Mod + Alt + V".

export interface ParsedChord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  ctrl: boolean; // explicit Ctrl (not Mod)
  key: string; // normalized: a-z, enter, backspace, delete, arrowleft, …
  /** Second key held with primary (e.g. K + J). */
  withKey?: string;
}

const ARROW: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
};

export function normalizeKey(key: string): string {
  const k = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  if (k === ' ') return 'space';
  if (k === 'escape') return 'escape';
  if (k === 'backspace') return 'backspace';
  if (k === 'delete') return 'delete';
  if (k === 'enter') return 'enter';
  if (k === 'tab') return 'tab';
  if (k === '`' || k === 'backquote') return '`';
  if (k === '/' || k === 'slash') return '/';
  if (k === '=' || k === 'equal') return '=';
  if (k === '+' || k === 'add') return '+';
  if (k === '-' || k === 'subtract' || k === 'minus') return '-';
  if (k.startsWith('arrow')) return k; // arrowleft …
  return k;
}

function tokenToKey(tok: string): string {
  const t = tok.trim().toLowerCase();
  if (t === 'space') return 'space';
  if (t === '←' || t === 'left') return 'arrowleft';
  if (t === '→' || t === 'right') return 'arrowright';
  if (t === '↑' || t === 'up') return 'arrowup';
  if (t === '↓' || t === 'down') return 'arrowdown';
  if (t === 'backspace') return 'backspace';
  if (t === 'delete') return 'delete';
  if (t === 'enter') return 'enter';
  if (t === 'tab') return 'tab';
  if (t === 'mod' || t === 'cmd' || t === 'command' || t === 'meta' || t === 'ctrl' || t === 'control' || t === 'alt' || t === 'option' || t === 'shift') {
    return ''; // modifiers handled separately
  }
  return t;
}

/** Parse one chord like "Mod + Alt + V" or "K + J". */
export function parseChord(raw: string): ParsedChord | null {
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let mod = false;
  let alt = false;
  let shift = false;
  let ctrl = false;
  const keys: string[] = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'mod' || low === 'cmd' || low === 'command' || low === 'meta') mod = true;
    else if (low === 'ctrl' || low === 'control') ctrl = true;
    else if (low === 'alt' || low === 'option') alt = true;
    else if (low === 'shift') shift = true;
    else {
      const k = tokenToKey(p);
      if (k) keys.push(k);
    }
  }
  if (!keys.length) return null;
  if (keys.length === 1) return { mod, alt, shift, ctrl, key: keys[0]! };
  // K + J style
  return { mod, alt, shift, ctrl, key: keys[keys.length - 1]!, withKey: keys[0] };
}

/** Split "A / B / C" into alternative chords. */
export function parseBindingAlts(keys: string): ParsedChord[] {
  if (!keys.trim()) return [];
  return keys
    .split('/')
    .map((s) => parseChord(s.trim()))
    .filter((c): c is ParsedChord => !!c);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown };
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  try {
    return !!el.closest?.('[contenteditable="true"]');
  } catch {
    return false;
  }
}

export interface MatchContext {
  /** Currently held non-modifier keys (lowercase normalized). */
  held: ReadonlySet<string>;
  isMac?: boolean;
}

/**
 * Return matching action id for this keydown, preferring longer/more-modified chords.
 * `catalog` items need { id, keys, disabledWhenTyping? }.
 */
export function matchShortcut(
  e: KeyboardEvent,
  catalog: { id: string; keys: string; disabledWhenTyping?: boolean }[],
  ctx: MatchContext,
): string | null {
  if (e.repeat) {
    // allow repeat only for seek/nudge — caller can filter; we still match
  }
  const key = normalizeKey(e.key);
  if (['shift', 'control', 'alt', 'meta'].includes(key)) return null;

  const typing = isTypingTarget(e.target);
  const isMac = ctx.isMac ?? (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform));

  type Cand = { id: string; score: number };
  const cands: Cand[] = [];

  for (const action of catalog) {
    if ((action.disabledWhenTyping !== false) && typing) continue;
    const alts = parseBindingAlts(action.keys);
    for (const chord of alts) {
      if (chord.key !== key && ARROW[key] !== chord.key) {
        // allow arrowleft vs ← already normalized to arrowleft
        if (chord.key !== key) continue;
      }
      // Mod = meta on Mac, ctrl on Windows
      const wantMod = chord.mod;
      const hasMod = isMac ? e.metaKey : e.ctrlKey;
      if (wantMod !== hasMod) continue;
      // explicit Ctrl (rare) — on Mac must be ctrlKey; on Win same as mod if only ctrl
      if (chord.ctrl) {
        if (!e.ctrlKey) continue;
        // if also mod and mac, both meta and ctrl unusual — require ctrl
      } else if (!wantMod && e.ctrlKey && !isMac) {
        // bare key shouldn't fire with ctrl held unless chord wants mod
        // (already handled by wantMod)
      }
      // when not wanting mod, reject accidental cmd/ctrl
      if (!wantMod && !chord.ctrl) {
        if (isMac && e.metaKey) continue;
        if (!isMac && e.ctrlKey) continue;
      }
      if (chord.alt !== e.altKey) continue;
      if (chord.shift !== e.shiftKey) continue;
      if (chord.withKey) {
        const need = normalizeKey(chord.withKey);
        if (!ctx.held.has(need) && need !== key) continue;
      }
      // score: more modifiers + combo wins
      let score = 0;
      if (wantMod) score += 4;
      if (chord.alt) score += 2;
      if (chord.shift) score += 2;
      if (chord.ctrl) score += 3;
      if (chord.withKey) score += 5;
      cands.push({ id: action.id, score });
    }
  }

  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  return cands[0]!.id;
}

export { isTypingTarget };
