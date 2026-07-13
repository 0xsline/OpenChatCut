import { useCallback, useMemo, useReducer } from 'react';
import type { AspectFit, TimelineItem, TimelineState, TrackId } from './types';
import { trackEnd } from './types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import { editedFrames, fillerIndices } from '../transcript/edit';

// ── command actions (these map 1:1 to the future agent tools) ─────────────
type Action =
  | { type: 'add'; item: Omit<TimelineItem, 'startFrame'>; startFrame?: number }
  | { type: 'updateProps'; id: string; patch: Record<string, unknown> }
  | { type: 'move'; id: string; track?: TrackId; startFrame?: number }
  | { type: 'retime'; id: string; startFrame?: number; durationInFrames?: number }
  | { type: 'duplicate'; id: string; newId: string }
  | { type: 'remove'; id: string }
  | { type: 'split'; id: string; atFrame: number; newId: string }
  | { type: 'clear' }
  | { type: 'setCanvas'; width: number; height: number; fit?: AspectFit }
  | { type: 'setCaptions'; captions: CaptionsData | null }
  | { type: 'updateCaptions'; patch: Partial<CaptionsData> }
  | { type: 'setItemTranscript'; id: string; words: TranscriptWord[] }
  | { type: 'toggleWord'; id: string; idx: number }
  | { type: 'deleteWords'; id: string; idxs: number[] }
  | { type: 'cleanScript'; id: string; silenceFrames?: number; removeFillers: boolean }
  | { type: 'clearEdits'; id: string }
  | { type: 'select'; id: string | null };

const MUTATING = new Set(['add', 'updateProps', 'move', 'retime', 'duplicate', 'remove', 'split', 'clear', 'setCanvas', 'setCaptions', 'updateCaptions', 'toggleWord', 'deleteWords', 'cleanScript', 'clearEdits']);

// recompute a transcript-edited clip's duration under its current edit state
function editedDuration(it: TimelineItem, deleted: Set<number>, fps: number): number {
  return editedFrames(it.transcript!, deleted, fps, { maxGapFrames: it.silenceFrames });
}

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
    case 'retime':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id
            ? {
                ...it,
                startFrame: Math.max(0, a.startFrame ?? it.startFrame),
                durationInFrames: Math.max(1, a.durationInFrames ?? it.durationInFrames),
              }
            : it,
        ),
      };
    case 'duplicate': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it) return s;
      const copy: TimelineItem = { ...it, id: a.newId, props: { ...it.props }, startFrame: trackEnd(s, it.track) };
      return { ...s, items: [...s.items, copy], selectedId: copy.id };
    }
    case 'clear':
      return { ...s, items: [], selectedId: null };
    case 'setCanvas':
      return { ...s, width: a.width, height: a.height, fit: a.fit ?? s.fit ?? 'contain' };
    case 'setCaptions':
      return { ...s, captions: a.captions };
    case 'updateCaptions':
      return s.captions ? { ...s, captions: { ...s.captions, ...a.patch } } : s;
    case 'setItemTranscript':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id ? { ...it, transcript: a.words, deletedWordIdx: [], silenceFrames: undefined, durationInFrames: editedFrames(a.words, new Set(), s.fps) } : it,
        ),
      };
    case 'toggleWord':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          del.has(a.idx) ? del.delete(a.idx) : del.add(a.idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'deleteWords':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          for (const idx of a.idxs) if (idx >= 0 && idx < it.transcript.length) del.add(idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'cleanScript':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          if (a.removeFillers) for (const idx of fillerIndices(it.transcript)) del.add(idx);
          const next = { ...it, deletedWordIdx: [...del], silenceFrames: a.silenceFrames };
          return { ...next, durationInFrames: editedDuration(next, del, s.fps) };
        }),
      };
    case 'clearEdits':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id && it.transcript ? { ...it, deletedWordIdx: [], silenceFrames: undefined, durationInFrames: editedFrames(it.transcript, new Set(), s.fps) } : it,
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
  addAudio: (asset: AudioAsset, at?: { track?: TrackId; startFrame?: number }) => void;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  moveItem: (id: string, to: { track?: TrackId; startFrame?: number }) => void;
  setItemTiming: (id: string, timing: { startFrame?: number; durationInFrames?: number }) => void;
  duplicateItem: (id: string) => void;
  removeItem: (id: string) => void;
  splitItem: (id: string, atFrame: number) => void;
  clearTimeline: () => void;
  setAspect: (width: number, height: number, fit?: AspectFit) => void;
  setCaptions: (captions: CaptionsData | null) => void;
  updateCaptions: (patch: Partial<CaptionsData>) => void;
  setItemTranscript: (id: string, words: TranscriptWord[]) => void;
  toggleWord: (id: string, idx: number) => void;
  deleteWords: (id: string, idxs: number[]) => void;
  cleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  clearEdits: (id: string) => void;
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
      addAudio: (asset, at) =>
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          item: {
            id: uid('item'),
            track: at?.track ?? 'A1',
            durationInFrames: asset.durationInFrames,
            kind: 'audio',
            name: asset.name,
            src: asset.src,
            volume: 1,
          },
        }),
      updateItemProps: (id, patch) => dispatch({ type: 'updateProps', id, patch }),
      moveItem: (id, to) => dispatch({ type: 'move', id, ...to }),
      setItemTiming: (id, timing) => dispatch({ type: 'retime', id, ...timing }),
      duplicateItem: (id) => dispatch({ type: 'duplicate', id, newId: uid('item') }),
      removeItem: (id) => dispatch({ type: 'remove', id }),
      splitItem: (id, atFrame) => dispatch({ type: 'split', id, atFrame, newId: uid('item') }),
      clearTimeline: () => dispatch({ type: 'clear' }),
      setAspect: (width, height, fit) => dispatch({ type: 'setCanvas', width, height, fit }),
      setCaptions: (captions) => dispatch({ type: 'setCaptions', captions }),
      updateCaptions: (patch) => dispatch({ type: 'updateCaptions', patch }),
      setItemTranscript: (id, words) => dispatch({ type: 'setItemTranscript', id, words }),
      toggleWord: (id, idx) => dispatch({ type: 'toggleWord', id, idx }),
      deleteWords: (id, idxs) => dispatch({ type: 'deleteWords', id, idxs }),
      cleanScript: (id, opts) => dispatch({ type: 'cleanScript', id, silenceFrames: opts.silenceFrames, removeFillers: opts.removeFillers }),
      clearEdits: (id) => dispatch({ type: 'clearEdits', id }),
      selectItem: (id) => dispatch({ type: 'select', id }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
    }),
    [], // dispatch is stable; placement now computed in the reducer
  );

  return { state: h.present, commands, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
