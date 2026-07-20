// User keymap overlay for the shortcut system: the default preset (SHORTCUT_CATALOG)
// with per-action user rebindings applied, persisted to localStorage. The dispatcher matches
// against effectiveCatalog(); the settings dialog rebinds via setBinding/resetBinding. Kept
// pure of React so both can share it (a tiny listener store drives re-renders).
import { SHORTCUT_CATALOG, type ShortcutAction } from './catalog';
import { parseBindingAlts, normalizeKey, type ParsedChord } from './match';

const LS_KEY = 'cc.keymap.v1';
type UserKeymap = Record<string, string>; // actionId → override binding string

function readLS(): UserKeymap {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    // keep only known action ids with string bindings
    const known = new Set(SHORTCUT_CATALOG.map((a) => a.id));
    const out: UserKeymap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (known.has(k) && typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeLS(m: UserKeymap): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch { /* private mode / quota */ }
}

let userKeymap: UserKeymap = readLS();
let cache: ShortcutAction[] | null = null;
const listeners = new Set<() => void>();

function invalidate(): void {
  cache = null;
  for (const fn of listeners) fn();
}

/** Subscribe to keymap changes (returns an unsubscribe). Used by the settings dialog. */
export function subscribeKeymap(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The catalog with user overrides applied (memoized until a binding changes). */
export function effectiveCatalog(): ShortcutAction[] {
  if (!cache) {
    cache = SHORTCUT_CATALOG.map((a) => (a.id in userKeymap ? { ...a, keys: userKeymap[a.id]! } : a));
  }
  return cache;
}

export function isCustomized(id: string): boolean { return id in userKeymap; }
export function customizedCount(): number { return Object.keys(userKeymap).length; }

export function setBinding(id: string, keys: string): void {
  const trimmed = keys.trim();
  if (!trimmed) return;
  userKeymap = { ...userKeymap, [id]: trimmed };
  writeLS(userKeymap);
  invalidate();
}

export function resetBinding(id: string): void {
  if (!(id in userKeymap)) return;
  const next = { ...userKeymap };
  delete next[id];
  userKeymap = next;
  writeLS(userKeymap);
  invalidate();
}

export function resetAllBindings(): void {
  if (!Object.keys(userKeymap).length) return;
  userKeymap = {};
  writeLS(userKeymap);
  invalidate();
}

const DISPLAY: Record<string, string> = {
  space: 'Space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  backspace: 'Backspace', delete: 'Delete', enter: 'Enter', tab: 'Tab',
};

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Serialize a captured keydown → a canonical binding string ("Mod + Shift + Z"), or null
 *  for a bare modifier / Escape (not a usable single-key binding). Uses the same "Mod"
 *  convention the catalog + matcher use (⌘ on Mac, Ctrl elsewhere). */
export function chordFromEvent(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  const key = normalizeKey(e.key);
  if (['shift', 'control', 'alt', 'meta', 'escape', 'unidentified'].includes(key)) return null;
  const mac = isMacPlatform();
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key in DISPLAY ? DISPLAY[key]! : (key.length === 1 ? key.toUpperCase() : key));
  return parts.join(' + ');
}

// Signature that uniquely identifies a chord regardless of formatting, for conflict checks.
function chordSig(c: ParsedChord): string {
  return `${c.mod ? 'M' : ''}${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}:${c.key}${c.withKey ? '+' + c.withKey : ''}`;
}

/** Other actions in `catalog` whose binding collides with `keys` (any shared chord). */
export function findConflicts(catalog: ShortcutAction[], id: string, keys: string): ShortcutAction[] {
  const target = new Set(parseBindingAlts(keys).map(chordSig));
  if (!target.size) return [];
  return catalog.filter((a) => a.id !== id && parseBindingAlts(a.keys).some((c) => target.has(chordSig(c))));
}
