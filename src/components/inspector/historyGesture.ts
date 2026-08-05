import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * The boundaries of continuous gestures. The slider and color picker will be gradually dispatched during dragging (so that there is a real-time preview),
 * But those steps must be merged into **one** undo record - otherwise volume 0→2 in 0.05 steps will push in about 40 snapshots,
 * The upper limit of history is only 100. Dragging the slider twice will squeeze out the user's real editing history.
 * The purpose of passing context is to avoid adding parameters to each of the dozen slider call points.
 */
export const HistoryGestureContext = createContext<{ begin: () => void; end: () => void } | null>(null);

/** The gesture starts when the pointer is pressed and ends when the pointer is released (no matter where it is released). The same goes for pressing the arrow keys on the keyboard.*/
export function useHistoryGesture(): {
  onPointerDown: () => void;
  onKeyDown: () => void;
  onKeyUp: () => void;
} {
  const gesture = useContext(HistoryGestureContext);
  const active = useRef(false);
  const end = () => {
    if (!active.current) return;
    active.current = false;
    gesture?.end();
  };
  const begin = () => {
    if (active.current) return;
    active.current = true;
    gesture?.begin();
  };
  // When the component is uninstalled (for example, the selected fragment is switched during dragging), it must also be finished to prevent the gesture from being turned on all the time.
  useEffect(() => () => {
    if (!active.current) return;
    active.current = false;
    gesture?.end();
  }, [gesture]);
  return {
    onPointerDown: () => {
      begin();
      // The pointer may be released outside the control, so listen to window rather than the control itself
      window.addEventListener('pointerup', end, { once: true });
      window.addEventListener('pointercancel', end, { once: true });
    },
    onKeyDown: begin,
    onKeyUp: end,
  };
}
