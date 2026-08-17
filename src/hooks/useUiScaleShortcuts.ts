import { useEffect } from 'react';

const ZOOM_STEP = 0.05;

/**
 * Desktop zoom accelerators (issue #85): Cmd/Ctrl + Plus/Minus steps the
 * saved UI scale by 5% (clamped 80%–150% in the main process), Cmd/Ctrl + 0
 * resets to 100%. Ignored while typing and when no desktop bridge exists —
 * browsers keep their own zoom shortcuts.
 */
export function useUiScaleShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const desktop = window.openChatCutDesktop;
      if (!desktop?.zoomStep) return;
      const key = event.key;
      if (key === '=' || key === '+') {
        event.preventDefault();
        void desktop.zoomStep(ZOOM_STEP);
      } else if (key === '-' || key === '_') {
        event.preventDefault();
        void desktop.zoomStep(-ZOOM_STEP);
      } else if (key === '0') {
        event.preventDefault();
        void desktop.zoomStep('reset');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
