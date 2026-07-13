import { useCallback, useMemo, useReducer } from 'react';
import type { TimelineItem, TimelineState, TrackId } from './types';
import { trackEnd } from './types';
import type { Tpl } from '../types';

// ── command actions (these map 1:1 to the future agent tools) ─────────────
type Action =
  | { type: 'add'; item: Omit<TimelineItem, 'startFrame'>; startFrame?: number }
  | { type: 'updateProps'; id: string; patch: Record<string, unknown> }
  | { type: 'move'; id: string; track?: TrackId; startFrame?: number }
  | { type: 'remove'; id: string }
  | { type: 'split'; id: string; atFrame: number; newId: string }
  | { type: 'select'; id: string | null };

const MUTATING = new Set(['add', 'updateProps', 'move', 'remove', 'split']);

function reduce(s: TimelineState, a: Action): TimelineState {
  switch (a.type) {
    case 'add': {
      // compute placement from CURRENT state (correct for sequential adds)
      const startFrame = a.startFrame ?? trackEnd(s, a.item.track);
      const item: TimelineItem = { ...a.item, startFrame };
      return { ...s, items: [...s.items, item], selectedId: item.id };
    }
    case 'updateProps':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id ? { ...it, props: { ...it.props, ...a.patch } } : it,
        ),
      };
    case 'move':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id
            ? { ...it, track: a.track ?? it.track, startFrame: Math.max(0, a.startFrame ?? it.startFrame) }
            : it,
        ),
      };
    case 'remove':
      return {
        ...s,
        items: s.items.filter((it) => it.id !== a.id),
        selectedId: s.selectedId === a.id ? null : s.selectedId,
      };
    case 'split': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it || a.atFrame <= it.startFrame || a.atFrame >= it.startFrame + it.durationInFrames) return s;
      const left = { ...it, durationInFrames: a.atFrame - it.startFrame };
      const right = { ...it, id: a.newId, startFrame: a.atFrame, durationInFrames: it.startFrame + it.durationInFrames - a.atFrame };
      return { ...s, items: s.items.flatMap((x) => (x.id === a.id ? [left, right] : [x])) };
    }
    case 'select':
      return { ...s, selectedId: a.id };
    default:
      return s;
  }
}

// ── history wrapper (snapshot-based undo/redo) ────────────────────────────
interface History {
  past: TimelineState[];
  present: TimelineState;
  future: TimelineState[];
}

function historyReduce(h: History, a: Action | { type: 'undo' } | { type: 'redo' }): History {
  if (a.type === 'undo') {
    if (!h.past.length) return h;
    const previous = h.past[h.past.length - 1];
    return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
  }
  if (a.type === 'redo') {
    if (!h.future.length) return h;
    const next = h.future[0];
    return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
  }
  const next = reduce(h.present, a);
  if (next === h.present) return h;
  if (MUTATING.has(a.type)) return { past: [...h.past, h.present], present: next, future: [] };
  return { ...h, present: next }; // select: no history
}

let counter = 0;
const uid = (p: string) => `${p}_${++counter}`;

export interface EditorCommands {
  addMotionGraphic: (tpl: Tpl, at?: { track?: TrackId; startFrame?: number }) => void;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  moveItem: (id: string, to: { track?: TrackId; startFrame?: number }) => void;
  removeItem: (id: string) => void;
  splitItem: (id: string, atFrame: number) => void;
  selectItem: (id: string | null) => void;
  undo: () => void;
  redo: () => void;
}

export function useEditor(initial: TimelineState): {
  state: TimelineState;
  commands: EditorCommands;
  canUndo: boolean;
  canRedo: boolean;
} {
  const [h, dispatch] = useReducer(historyReduce, { past: [], present: initial, future: [] });

  const commands = useMemo<EditorCommands>(
    () => ({
      addMotionGraphic: (tpl, at) =>
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          item: {
            id: uid('item'),
            track: at?.track ?? 'V1',
            durationInFrames: tpl.durationInFrames,
            kind: 'motion-graphic',
            templateId: tpl.id,
            name: tpl.name,
            code: tpl.code,
            props: { ...tpl.props },
            width: tpl.width,
            height: tpl.height,
          },
        }),
      updateItemProps: (id, patch) => dispatch({ type: 'updateProps', id, patch }),
      moveItem: (id, to) => dispatch({ type: 'move', id, ...to }),
      removeItem: (id) => dispatch({ type: 'remove', id }),
      splitItem: (id, atFrame) => dispatch({ type: 'split', id, atFrame, newId: uid('item') }),
      selectItem: (id) => dispatch({ type: 'select', id }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
    }),
    [], // dispatch is stable; placement now computed in the reducer
  );

  return { state: h.present, commands, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
