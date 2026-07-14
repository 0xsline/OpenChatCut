import { useEffect, useRef } from 'react';
import { SHORTCUT_CATALOG } from './catalog';
import { matchShortcut, normalizeKey, isTypingTarget } from './match';

export type ShortcutHandler = (ctx: { shift: boolean; alt: boolean; mod: boolean }) => void;

/**
 * Global keydown dispatcher for the ChatCut default preset.
 * Handlers are looked up by action id; missing handlers are no-ops.
 */
export function useShortcutDispatcher(
  handlers: Partial<Record<string, ShortcutHandler>>,
  opts?: { enabled?: boolean },
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabled = opts?.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const held = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      const nk = normalizeKey(e.key);
      if (!['shift', 'control', 'alt', 'meta'].includes(nk)) held.add(nk);

      // Shift+Backspace is ripple-delete — special case: still match delete with shift
      const id = matchShortcut(e, SHORTCUT_CATALOG, { held });
      if (!id) return;
      const fn = handlersRef.current[id];
      if (!fn) return;

      // Tab in non-typing: ask-ai; don't steal tab in inputs
      if (id === 'ask-ai' && isTypingTarget(e.target)) return;

      e.preventDefault();
      const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
      fn({
        shift: e.shiftKey,
        alt: e.altKey,
        mod: isMac ? e.metaKey : e.ctrlKey,
      });
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
