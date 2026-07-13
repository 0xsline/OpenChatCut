import { useMemo, useReducer } from 'react';
import type { AspectFit, ClipFilters, ClipTransform, MediaAsset, TimelineItem, TimelineState, TrackId, TransitionItem, TransitionType, ZoomEffect } from './types';
import { trackEnd } from './types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import { editedFrames, fillerIndices } from '../transcript/edit';

// ── command actions (these map 1:1 to the future agent tools) ─────────────
export type Action =
  | { type: 'add'; item: Omit<TimelineItem, 'startFrame'>; startFrame?: number }
  | { type: 'updateProps'; id: string; patch: Record<string, unknown> }
  | { type: 'move'; id: string; track?: TrackId; startFrame?: number }
  | { type: 'retime'; id: string; startFrame?: number; durationInFrames?: number; srcInFrame?: number }
  | { type: 'setVolume'; id: string; volume: number }
  | { type: 'setFade'; id: string; fadeInFrames?: number; fadeOutFrames?: number }
  | { type: 'setTransform'; id: string; patch: ClipTransform }
  | { type: 'setFilters'; id: string; patch: ClipFilters }
  | { type: 'setZoom'; id: string; patch: Partial<ZoomEffect> | null }
  | { type: 'reframeKeyframe'; id: string; frame: number; focalPointX: number; focalPointY: number; magnification: number }
  | { type: 'removeReframeKeyframe'; id: string; frame: number }
  | { type: 'addTransition'; id: string; incomingItemId: string; transType: TransitionType; durationInFrames?: number }
  | { type: 'setTransition'; id: string; patch: Partial<TransitionItem> }
  | { type: 'removeTransition'; id: string }
  | { type: 'duplicate'; id: string; newId: string }
  | { type: 'remove'; id: string }
  | { type: 'split'; id: string; atFrame: number; newId: string }
  | { type: 'clear' }
  | { type: 'addAsset'; asset: MediaAsset }
  | { type: 'setCanvas'; width: number; height: number; fit?: AspectFit }
  | { type: 'toggleTrack'; track: TrackId; flag: 'hidden' | 'muted' }
  | { type: 'setCaptions'; captions: CaptionsData | null }
  | { type: 'updateCaptions'; patch: Partial<CaptionsData> }
  | { type: 'setItemTranscript'; id: string; words: TranscriptWord[] }
  | { type: 'toggleWord'; id: string; idx: number }
  | { type: 'deleteWords'; id: string; idxs: number[] }
  | { type: 'cleanScript'; id: string; silenceFrames?: number; removeFillers: boolean }
  | { type: 'clearEdits'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'setFullState'; state: TimelineState };

/** dispatch accepted by the command set: store actions + history undo/redo */
export type Dispatch = (a: Action | { type: 'undo' } | { type: 'redo' }) => void;

const MUTATING = new Set(['add', 'updateProps', 'move', 'retime', 'setVolume', 'setFade', 'setTransform', 'setFilters', 'setZoom', 'reframeKeyframe', 'removeReframeKeyframe', 'addTransition', 'setTransition', 'removeTransition', 'duplicate', 'remove', 'split', 'clear', 'addAsset', 'setCanvas', 'toggleTrack', 'setCaptions', 'updateCaptions', 'toggleWord', 'deleteWords', 'cleanScript', 'clearEdits', 'setFullState']);

const EMPTY_CURVE = { version: 1, timebase: 'effect-frame', coordinateSpace: 'composition-normalized', keyframes: [] } as const;

// recompute a transcript-edited clip's duration under its current edit state
function editedDuration(it: TimelineItem, deleted: Set<number>, fps: number): number {
  return editedFrames(it.transcript!, deleted, fps, { maxGapFrames: it.silenceFrames });
}

export function reduce(s: TimelineState, a: Action): TimelineState {
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
                srcInFrame: a.srcInFrame === undefined ? it.srcInFrame : Math.max(0, a.srcInFrame),
              }
            : it,
        ),
      };
    case 'setVolume':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, volume: Math.max(0, Math.min(2, a.volume)) } : it)),
      };
    case 'setFade':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          // clamp each fade to at most the clip's length; keep the other side unchanged
          const cap = it.durationInFrames;
          return {
            ...it,
            fadeInFrames: a.fadeInFrames === undefined ? it.fadeInFrames : Math.max(0, Math.min(cap, a.fadeInFrames)),
            fadeOutFrames: a.fadeOutFrames === undefined ? it.fadeOutFrames : Math.max(0, Math.min(cap, a.fadeOutFrames)),
          };
        }),
      };
    case 'setTransform':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, transform: { ...it.transform, ...a.patch } } : it)),
      };
    case 'setFilters':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, filters: { ...it.filters, ...a.patch } } : it)),
      };
    case 'setZoom':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, zoom: a.patch === null ? undefined : { ...it.zoom, ...a.patch } } : it)),
      };
    case 'reframeKeyframe':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const zoom = it.zoom ?? {};
          const curve = zoom.reframeCurve ?? EMPTY_CURVE;
          // replace any keyframe at the same frame, then keep sorted
          const keyframes = [
            ...curve.keyframes.filter((k) => k.frame !== a.frame),
            { frame: a.frame, focalPointX: a.focalPointX, focalPointY: a.focalPointY, magnification: a.magnification },
          ].sort((x, y) => x.frame - y.frame);
          return { ...it, zoom: { ...zoom, reframeCurve: { ...curve, keyframes } } };
        }),
      };
    case 'removeReframeKeyframe':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.zoom?.reframeCurve) return it;
          const keyframes = it.zoom.reframeCurve.keyframes.filter((k) => k.frame !== a.frame);
          const reframeCurve = keyframes.length ? { ...it.zoom.reframeCurve, keyframes } : undefined;
          return { ...it, zoom: { ...it.zoom, reframeCurve } };
        }),
      };
    case 'addTransition': {
      const inItem = s.items.find((x) => x.id === a.incomingItemId);
      if (!inItem || inItem.kind === 'audio') return s;
      // outgoing = the same-track visual clip whose end sits at (adjacent to) the incoming's start
      const prior = s.items.filter(
        (x) => x.id !== inItem.id && x.track === inItem.track && x.kind !== 'audio' && x.startFrame + x.durationInFrames <= inItem.startFrame + 2,
      );
      if (!prior.length) return s;
      const out = prior.reduce((best, x) => (x.startFrame + x.durationInFrames > best.startFrame + best.durationInFrames ? x : best));
      if (inItem.startFrame - (out.startFrame + out.durationInFrames) > 2) return s; // must be adjacent
      const maxL = Math.max(2, Math.min(out.durationInFrames, inItem.durationInFrames));
      const L = Math.max(2, Math.min(a.durationInFrames ?? Math.min(30, maxL), maxL));
      const t: TransitionItem = { id: a.id, type: a.transType, durationInFrames: L, outgoingItemId: out.id, incomingItemId: inItem.id, trackId: inItem.track, enabled: true };
      const others = (s.transitions ?? []).filter((x) => x.incomingItemId !== inItem.id); // one in-transition per clip
      return { ...s, transitions: [...others, t] };
    }
    case 'setTransition':
      return {
        ...s,
        transitions: (s.transitions ?? []).map((t) => {
          if (t.id !== a.id) return t;
          const merged = { ...t, ...a.patch };
          if (a.patch.durationInFrames !== undefined) {
            // can't exceed either clip's length (avoids freeze frames / overlap, like source edit_item)
            const out = s.items.find((x) => x.id === t.outgoingItemId);
            const inc = s.items.find((x) => x.id === t.incomingItemId);
            const maxL = Math.max(2, Math.min(out?.durationInFrames ?? 2, inc?.durationInFrames ?? 2));
            merged.durationInFrames = Math.max(2, Math.min(merged.durationInFrames, maxL));
          }
          return merged;
        }),
      };
    case 'removeTransition':
      return { ...s, transitions: (s.transitions ?? []).filter((t) => t.id !== a.id) };
    case 'duplicate': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it) return s;
      const copy: TimelineItem = { ...it, id: a.newId, props: { ...it.props }, startFrame: trackEnd(s, it.track) };
      return { ...s, items: [...s.items, copy], selectedId: copy.id };
    }
    case 'clear':
      return { ...s, items: [], selectedId: null };
    case 'addAsset':
      return { ...s, assets: [...(s.assets ?? []), a.asset] };
    case 'setCanvas':
      return { ...s, width: a.width, height: a.height, fit: a.fit ?? s.fit ?? 'contain' };
    case 'toggleTrack': {
      const cur = s.tracks?.[a.track] ?? {};
      return { ...s, tracks: { ...s.tracks, [a.track]: { ...cur, [a.flag]: !cur[a.flag] } } };
    }
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
        // drop transitions that referenced the removed clip
        transitions: (s.transitions ?? []).filter((t) => t.incomingItemId !== a.id && t.outgoingItemId !== a.id),
        selectedId: s.selectedId === a.id ? null : s.selectedId,
      };
    case 'split': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it || a.atFrame <= it.startFrame || a.atFrame >= it.startFrame + it.durationInFrames) return s;
      const cut = a.atFrame - it.startFrame; // frames of source consumed by the left half
      const left = { ...it, durationInFrames: cut };
      // the right half resumes the source where the left one ended (advances srcInFrame)
      const right = { ...it, id: a.newId, startFrame: a.atFrame, durationInFrames: it.durationInFrames - cut, srcInFrame: (it.srcInFrame ?? 0) + cut };
      return { ...s, items: s.items.flatMap((x) => (x.id === a.id ? [left, right] : [x])) };
    }
    case 'select':
      return { ...s, selectedId: a.id };
    case 'setFullState':
      return a.state; // atomic commit of a proposal's result (one history step)
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

// Ids must stay unique across sessions: items are persisted to IndexedDB, so a
// process-local counter (which resets to 0 on every reload) would regenerate ids
// that already exist and collide (e.g. split/duplicate reusing a live id →
// two items share an id → moveItem moves both). crypto.randomUUID avoids that.
const uid = (p: string) => `${p}_${crypto.randomUUID()}`;

export interface EditorCommands {
  addMotionGraphic: (tpl: Tpl, at?: { track?: TrackId; startFrame?: number }) => void;
  addAudio: (asset: AudioAsset, at?: { track?: TrackId; startFrame?: number }) => void;
  addAsset: (asset: MediaAsset) => void;
  addMediaItem: (asset: MediaAsset, at?: { track?: TrackId; startFrame?: number }) => void;
  addTextClip: (at?: { track?: TrackId; startFrame?: number; durationInFrames?: number }) => void;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  moveItem: (id: string, to: { track?: TrackId; startFrame?: number }) => void;
  setItemTiming: (id: string, timing: { startFrame?: number; durationInFrames?: number; srcInFrame?: number }) => void;
  setItemVolume: (id: string, volume: number) => void;
  setItemFade: (id: string, fade: { fadeInFrames?: number; fadeOutFrames?: number }) => void;
  setItemTransform: (id: string, patch: ClipTransform) => void;
  setItemFilters: (id: string, patch: ClipFilters) => void;
  setItemZoom: (id: string, patch: Partial<ZoomEffect> | null) => void;
  setReframeKeyframe: (id: string, frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  removeReframeKeyframe: (id: string, frame: number) => void;
  addTransition: (incomingItemId: string, type: TransitionType, durationInFrames?: number) => void;
  setTransition: (id: string, patch: Partial<TransitionItem>) => void;
  removeTransition: (id: string) => void;
  duplicateItem: (id: string) => void;
  removeItem: (id: string) => void;
  splitItem: (id: string, atFrame: number) => void;
  clearTimeline: () => void;
  setAspect: (width: number, height: number, fit?: AspectFit) => void;
  toggleTrackFlag: (track: TrackId, flag: 'hidden' | 'muted') => void;
  setCaptions: (captions: CaptionsData | null) => void;
  updateCaptions: (patch: Partial<CaptionsData>) => void;
  setItemTranscript: (id: string, words: TranscriptWord[]) => void;
  toggleWord: (id: string, idx: number) => void;
  deleteWords: (id: string, idxs: number[]) => void;
  cleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  clearEdits: (id: string) => void;
  selectItem: (id: string | null) => void;
  /** atomically replace the whole timeline (proposal apply → one undo step) */
  applyState: (state: TimelineState) => void;
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

  const commands = useMemo(() => buildCommands(dispatch), []);

  return { state: h.present, commands, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

// The editor command set over a dispatch fn — reused by the live store (real
// dispatch → history) and by the proposal draft engine (draft dispatch that
// records + applies to a scratch state without touching the real timeline).
function buildCommands(dispatch: Dispatch): EditorCommands {
  return {
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
      addTextClip: (at) =>
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          item: {
            id: uid('item'),
            track: at?.track ?? 'V2', // titles default to the top video track
            durationInFrames: at?.durationInFrames ?? 90,
            kind: 'text',
            name: '文字',
            width: 1920,
            height: 1080,
            props: { text: '双击编辑文字', fontSize: 96, color: '#ffffff', fontWeight: 700, align: 'center' },
          },
        }),
      addAsset: (asset) => dispatch({ type: 'addAsset', asset }),
      addMediaItem: (asset, at) =>
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          item: {
            id: uid('item'),
            track: at?.track ?? (asset.kind === 'audio' ? 'A1' : 'V1'),
            durationInFrames: asset.durationInFrames,
            kind: asset.kind,
            name: asset.name,
            src: asset.src,
            volume: asset.kind === 'audio' || asset.kind === 'video' ? 1 : undefined,
            width: asset.width,
            height: asset.height,
          },
        }),
      updateItemProps: (id, patch) => dispatch({ type: 'updateProps', id, patch }),
      moveItem: (id, to) => dispatch({ type: 'move', id, ...to }),
      setItemTiming: (id, timing) => dispatch({ type: 'retime', id, ...timing }),
      setItemVolume: (id, volume) => dispatch({ type: 'setVolume', id, volume }),
      setItemFade: (id, fade) => dispatch({ type: 'setFade', id, ...fade }),
      setItemTransform: (id, patch) => dispatch({ type: 'setTransform', id, patch }),
      setItemFilters: (id, patch) => dispatch({ type: 'setFilters', id, patch }),
      setItemZoom: (id, patch) => dispatch({ type: 'setZoom', id, patch }),
      setReframeKeyframe: (id, frame, focalPointX, focalPointY, magnification) => dispatch({ type: 'reframeKeyframe', id, frame, focalPointX, focalPointY, magnification }),
      removeReframeKeyframe: (id, frame) => dispatch({ type: 'removeReframeKeyframe', id, frame }),
      addTransition: (incomingItemId, type, durationInFrames) => dispatch({ type: 'addTransition', id: uid('tr'), incomingItemId, transType: type, durationInFrames }),
      setTransition: (id, patch) => dispatch({ type: 'setTransition', id, patch }),
      removeTransition: (id) => dispatch({ type: 'removeTransition', id }),
      duplicateItem: (id) => dispatch({ type: 'duplicate', id, newId: uid('item') }),
      removeItem: (id) => dispatch({ type: 'remove', id }),
      splitItem: (id, atFrame) => dispatch({ type: 'split', id, atFrame, newId: uid('item') }),
      clearTimeline: () => dispatch({ type: 'clear' }),
      setAspect: (width, height, fit) => dispatch({ type: 'setCanvas', width, height, fit }),
      toggleTrackFlag: (track, flag) => dispatch({ type: 'toggleTrack', track, flag }),
      setCaptions: (captions) => dispatch({ type: 'setCaptions', captions }),
      updateCaptions: (patch) => dispatch({ type: 'updateCaptions', patch }),
      setItemTranscript: (id, words) => dispatch({ type: 'setItemTranscript', id, words }),
      toggleWord: (id, idx) => dispatch({ type: 'toggleWord', id, idx }),
      deleteWords: (id, idxs) => dispatch({ type: 'deleteWords', id, idxs }),
      cleanScript: (id, opts) => dispatch({ type: 'cleanScript', id, silenceFrames: opts.silenceFrames, removeFillers: opts.removeFillers }),
      clearEdits: (id) => dispatch({ type: 'clearEdits', id }),
      selectItem: (id) => dispatch({ type: 'select', id }),
      applyState: (state) => dispatch({ type: 'setFullState', state }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
  };
}

// ── proposal draft engine ─────────────────────────────────────────────────
// Runs the agent's tools against a scratch copy of the timeline (so it sees its
// own pending edits) WITHOUT touching the real store, recording every store
// action. The recorded actions are grouped per agent tool call into operations,
// and replayed on approve to commit atomically.
export interface DraftEngine {
  commands: EditorCommands;
  getState: () => TimelineState;
  /** actions recorded since the last checkpoint() */
  takeActions: () => Action[];
}

export function makeDraft(base: TimelineState): DraftEngine {
  let state = base;
  let pending: Action[] = [];
  const dispatch: Dispatch = (a) => {
    if (a.type === 'undo' || a.type === 'redo') return; // history is meaningless in a draft
    const next = reduce(state, a);
    if (next !== state) {
      state = next;
      pending.push(a);
    }
  };
  return {
    commands: buildCommands(dispatch),
    getState: () => state,
    takeActions: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

/** replay recorded actions on a base state (proposal apply, subset-safe) */
export function replayActions(base: TimelineState, actions: Action[]): TimelineState {
  return actions.reduce((s, a) => reduce(s, a), base);
}
