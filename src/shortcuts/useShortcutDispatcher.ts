import { useEffect } from 'react';
import { matchShortcut, normalizeKey, isTypingTarget } from './match';
import { effectiveCatalog } from './keymap';
import { invokeAction } from './actionRegistry';

export type ShortcutHandler = (ctx: { shift: boolean; alt: boolean; mod: boolean }) => void;

/**
 * Global keydown dispatcher for the default preset.
 * Keyboard matching is only an input adapter. Every surface dispatches through
 * the same action registry, so toolbar/menu/shortcut behavior cannot drift.
 */
export function useShortcutDispatcher(
  opts?: { enabled?: boolean },
): void {
  const enabled = opts?.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const held = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      const nk = normalizeKey(e.key);
      if (!['shift', 'control', 'alt', 'meta'].includes(nk)) held.add(nk);

      // Shift+Backspace is ripple-delete — special case: still match delete with shift
      const id = matchShortcut(e, effectiveCatalog(), { held });
      if (!id) return;

      // Tab in non-typing: ask-ai; don't steal tab in inputs
      if (id === 'ask-ai' && isTypingTarget(e.target)) return;

      const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
      const handled = invokeAction(id, {
        shift: e.shiftKey,
        alt: e.altKey,
        mod: isMac ? e.metaKey : e.ctrlKey,
      }, 'shortcut');
      if (handled) e.preventDefault();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(normalizeKey(e.key));
    };
    const onBlur = () => held.clear();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);
}
