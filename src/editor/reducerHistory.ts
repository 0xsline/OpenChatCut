import type { ProjectDoc } from './types';
import type { AnyAction, HistoryControlAction } from './reducerActions';
import { MUTATING } from './reducerActions';
import { projectReduce } from './reducerProject';

// ── history wrapper (snapshot-based undo/redo over the whole project) ──────
export interface History {
  past: ProjectDoc[];
  present: ProjectDoc;
  future: ProjectDoc[];
  /**
   * Merge status during continuous gestures (drag the slider, drag the color picker). 'open' = The gesture has started but no changes have been made;
   * 'pushed' = This gesture has been pushed through history once, and only present will be changed in subsequent steps.
   *
   * Without it, volume 0→2 will push in about 40 snapshots in 0.05 steps, while HISTORY_LIMIT is only 100
   * — Drag the slider twice to squeeze out the user's real editing history, and undo only backs out one space.
   */
  gesture?: 'open' | 'pushed';
}

const HISTORY_LIMIT = 100;
const pushHistory = (past: ProjectDoc[], doc: ProjectDoc) => [...past, doc].slice(-HISTORY_LIMIT);

function reduceHistoryAction(present: ProjectDoc, action: AnyAction): {
  next: ProjectDoc;
  mutating: boolean;
} {
  if (action.type !== 'batch') {
    const next = projectReduce(present, action);
    return { next, mutating: next !== present && MUTATING.has(action.type) };
  }
  let next = present;
  let mutating = false;
  for (const entry of action.actions) {
    const reduced = projectReduce(next, entry);
    if (reduced !== next && MUTATING.has(entry.type)) mutating = true;
    next = reduced;
  }
  return { next, mutating };
}

export function historyReduce(h: History, a: AnyAction | HistoryControlAction): History {
  // Gesture boundaries are given by the UI (pointer pressed/released). At the beginning, only the status is recorded and the history is not touched.
  if (a.type === 'history.beginGesture') return h.gesture ? h : { ...h, gesture: 'open' };
  if (a.type === 'history.endGesture') return h.gesture ? { ...h, gesture: undefined } : h;
  if (a.type === 'undo') {
    if (!h.past.length) return h;
    const previous = h.past[h.past.length - 1];
    return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], gesture: undefined };
  }
  if (a.type === 'redo') {
    if (!h.future.length) return h;
    const next = h.future[0];
    return { past: pushHistory(h.past, h.present), present: next, future: h.future.slice(1), gesture: undefined };
  }
  const { next, mutating } = reduceHistoryAction(h.present, a);
  if (next === h.present) return h;
  if (mutating) {
    // Only one history is pushed at a time: the first step is pushed onto the stack as usual, and subsequent steps only replace present.
    // Undo returns to "before dragging", not the previous tick.
    if (h.gesture === 'pushed') return { ...h, present: next, future: [] };
    return {
      past: pushHistory(h.past, h.present),
      present: next,
      future: [],
      ...(h.gesture ? { gesture: 'pushed' as const } : {}),
    };
  }
  return { ...h, present: next }; // select / tl.switch: no history
}
