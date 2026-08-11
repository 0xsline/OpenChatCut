import { useCallback, useMemo, useReducer, useRef } from 'react';
import type { ProjectDoc, Timeline, TimelineState } from './types';
import { activeEditorState } from './types';
import type { AnyAction, ProjectDispatch } from './reduce';
import { historyReduce, isHistoryControlAction, projectReduce } from './reduce';
import { buildCommands } from './storeCommandBuilder';
import type { EditorCommands } from './storeCommands';

// Re-export the reducer layer so existing importers (`from './editor/store'`) keep working.
export type { Action, AnyAction, AtomicAction, BatchAction, ProjectAction, Dispatch, ProjectDispatch } from './reduce';
export { reduce, projectReduce } from './reduce';
export type { MediaRelinkResult } from './types';
export type { AddSequenceResult, EditorCommands } from './storeCommands';

export function useEditor(initial: ProjectDoc): {
  /** the active timeline — what the composition/export/inspector operate on */
  state: Timeline;
  /** the whole project (all timelines + which is active) — persisted, tab bar */
  doc: ProjectDoc;
  commands: EditorCommands;
  canUndo: boolean;
  canRedo: boolean;
  /** The complete project snapshot of the previous step (undo target), null if there is no history. Agent's "undo" tool
   * Treat the proposal as an ordinary editor, rather than directly touching the history stack - the draft baseline will not become invalid.*/
  getUndoTarget: () => ProjectDoc | null;
  /** Next redo snapshot (future[0]), null when there is nothing to redo. Agent redo_last_change applies it via applyDoc. */
  getRedoTarget: () => ProjectDoc | null;
} {
  const [h, dispatch] = useReducer(historyReduce, { past: [], present: initial, future: [] });
  const doc = h.present;
  // Timeline commands need the current project for timeline counts and ids;
  // a ref keeps buildCommands' memo stable while reading live state.
  const docRef = useRef(doc);
  docRef.current = doc;

  const commands = useMemo<EditorCommands>(() => buildCommands(dispatch, () => docRef.current), []);

  const pastRef = useRef(h.past);
  pastRef.current = h.past;
  const futureRef = useRef(h.future);
  futureRef.current = h.future;
  const getUndoTarget = useCallback((): ProjectDoc | null => pastRef.current[pastRef.current.length - 1] ?? null, []);
  const getRedoTarget = useCallback((): ProjectDoc | null => futureRef.current[0] ?? null, []);

  return {
    state: activeEditorState(doc),
    doc,
    commands,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    getUndoTarget,
    getRedoTarget,
  };
}

// ── proposal draft engine ─────────────────────────────────────────────────
// Runs the agent's tools against a scratch copy of the PROJECT (so it sees its
// own pending edits, including timeline switches) WITHOUT touching the real
// store, recording every store action. The recorded actions are grouped per
// agent tool call into operations, and replayed on approve to commit atomically.
export interface DraftEngine {
  commands: EditorCommands;
  /** the draft's ACTIVE timeline (what per-clip tools operate on) */
  getState: () => TimelineState;
  /** the whole draft project (manage_timelines operates on this) */
  getDoc: () => ProjectDoc;
  /** actions recorded since the last takeActions() */
  takeActions: () => AnyAction[];
}

export function makeDraft(base: ProjectDoc): DraftEngine {
  let doc = base;
  let pending: AnyAction[] = [];
  const dispatch: ProjectDispatch = (a) => {
    // Draft is a copy of the project, replay of recorded actions, history stack and gesture merging are meaningless here.
    if (isHistoryControlAction(a)) return;
    const next = projectReduce(doc, a);
    if (next !== doc) {
      doc = next;
      pending.push(a);
    }
  };
  return {
    commands: buildCommands(dispatch, () => doc),
    getState: () => activeEditorState(doc),
    getDoc: () => doc,
    takeActions: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

/** replay recorded actions on a base project (proposal apply, subset-safe) */
export function replayActions(base: ProjectDoc, actions: AnyAction[]): ProjectDoc {
  return actions.reduce((d, a) => projectReduce(d, a), base);
}
