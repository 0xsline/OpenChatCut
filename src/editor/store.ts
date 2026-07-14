import { useMemo, useReducer, useRef } from 'react';
import type { AspectFit, ClipEffect, ClipFilters, ClipTransform, Marker, MediaAsset, ProjectDoc, Timeline, TimelineState, TrackId, TransitionItem, TransitionType, ZoomEffect } from './types';
import { activeTimeline } from './types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import type { AnyAction, ProjectDispatch } from './reduce';
import { historyReduce, maxOrder, projectReduce } from './reduce';

// Re-export the reducer layer so existing importers (`from './editor/store'`) keep working.
export type { Action, AnyAction, ProjectAction, Dispatch, ProjectDispatch } from './reduce';
export { reduce, projectReduce } from './reduce';

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
  addTextClip: (at?: { track?: TrackId; startFrame?: number; durationInFrames?: number; ripple?: boolean }) => void;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  moveItem: (id: string, to: { track?: TrackId; startFrame?: number }) => void;
  setItemTiming: (id: string, timing: { startFrame?: number; durationInFrames?: number; srcInFrame?: number }) => void;
  setItemVolume: (id: string, volume: number) => void;
  setItemFade: (id: string, fade: { fadeInFrames?: number; fadeOutFrames?: number }) => void;
  setItemTransform: (id: string, patch: ClipTransform) => void;
  setItemFilters: (id: string, patch: ClipFilters) => void;
  setItemZoom: (id: string, patch: Partial<ZoomEffect> | null) => void;
  /** replace a clip's per-clip WebGL effect stack (source effects[]) */
  setItemEffects: (id: string, effects: ClipEffect[]) => void;
  /** set playback speed (source 变速); retimes the clip to keep its source span */
  setItemSpeed: (id: string, rate: number) => void;
  /** add a ruler/clip marker at a frame (source manage_markers create); returns its id */
  addMarker: (fromFrame: number, opts?: { note?: string; color?: Marker['color']; durationFrames?: number; scope?: Marker['scope']; itemId?: string }) => string;
  updateMarker: (id: string, patch: Partial<Marker>) => void;
  removeMarker: (id: string) => void;
  setReframeKeyframe: (id: string, frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  removeReframeKeyframe: (id: string, frame: number) => void;
  addTransition: (incomingItemId: string, type: TransitionType, durationInFrames?: number) => void;
  setTransition: (id: string, patch: Partial<TransitionItem>) => void;
  removeTransition: (id: string) => void;
  duplicateItem: (id: string) => void;
  removeItem: (id: string) => void;
  /** ripple delete: remove a clip AND close the gap (shift later same-track clips left) */
  rippleDeleteItem: (id: string) => void;
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
  /** atomically replace the whole project (project-level proposal apply → one undo step) */
  applyDoc: (doc: ProjectDoc) => void;
  // ── multi-timeline (source manage_timelines) ──
  /** add a new empty timeline (inherits the active canvas unless sized); returns its id */
  createTimeline: (opts?: { name?: string; width?: number; height?: number; fit?: AspectFit; activate?: boolean }) => string;
  /** make a timeline active (no history step) */
  switchTimeline: (id: string) => void;
  /** copy a timeline (optionally retargeting the canvas for long→short); returns the copy's id */
  duplicateTimeline: (id: string, opts?: { name?: string; retarget?: { width: number; height: number; fit?: AspectFit }; activate?: boolean }) => string;
  deleteTimeline: (id: string) => void;
  renameTimeline: (id: string, name: string) => void;
  retargetTimeline: (id: string, width: number, height: number, fit?: AspectFit) => void;
  /** hide/restore a timeline tab (source update.hidden); the last visible one can't hide */
  setTimelineHidden: (id: string, hidden: boolean) => void;
  undo: () => void;
  redo: () => void;
}

export function useEditor(initial: ProjectDoc): {
  /** the active timeline — what the composition/export/inspector operate on */
  state: Timeline;
  /** the whole project (all timelines + which is active) — persisted, tab bar */
  doc: ProjectDoc;
  commands: EditorCommands;
  canUndo: boolean;
  canRedo: boolean;
} {
  const [h, dispatch] = useReducer(historyReduce, { past: [], present: initial, future: [] });
  const doc = h.present;
  // timeline commands need the CURRENT project (new timeline count, source ids);
  // a ref keeps buildCommands' memo stable while reading live state.
  const docRef = useRef(doc);
  docRef.current = doc;

  const commands = useMemo<EditorCommands>(() => buildCommands(dispatch, () => docRef.current), []);

  return { state: activeTimeline(doc), doc, commands, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

// The editor command set over a project dispatch fn — reused by the live store
// (real dispatch → history) and by the proposal draft engine (draft dispatch
// that records + applies to a scratch ProjectDoc without touching the real one).
function buildCommands(dispatch: ProjectDispatch, getDoc: () => ProjectDoc): EditorCommands {
  return {
      createTimeline: (opts) => {
        const d = getDoc();
        const base = activeTimeline(d);
        const t: Timeline = {
          fps: base.fps,
          width: opts?.width ?? base.width,
          height: opts?.height ?? base.height,
          fit: opts?.fit ?? base.fit,
          items: [], selectedId: null,
          id: uid('tl'), name: opts?.name ?? `序列 ${d.timelines.length + 1}`, order: maxOrder(d) + 1,
        };
        dispatch({ type: 'tl.create', timeline: t, activate: opts?.activate });
        return t.id;
      },
      switchTimeline: (id) => dispatch({ type: 'tl.switch', id }),
      duplicateTimeline: (id, opts) => {
        const src = getDoc().timelines.find((t) => t.id === id);
        const newId = uid('tl');
        dispatch({ type: 'tl.duplicate', id, newId, name: opts?.name ?? `${src?.name ?? '序列'} 副本`, retarget: opts?.retarget, activate: opts?.activate });
        return newId;
      },
      deleteTimeline: (id) => dispatch({ type: 'tl.delete', id }),
      renameTimeline: (id, name) => dispatch({ type: 'tl.rename', id, name }),
      retargetTimeline: (id, width, height, fit) => dispatch({ type: 'tl.retarget', id, width, height, fit }),
      setTimelineHidden: (id, hidden) => dispatch({ type: 'tl.setHidden', id, hidden }),
      applyDoc: (doc) => dispatch({ type: 'tl.setDoc', doc }),
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
          ripple: at?.ripple,
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
      setItemEffects: (id, effects) => dispatch({ type: 'setEffects', id, effects }),
      setItemSpeed: (id, rate) => dispatch({ type: 'setSpeed', id, rate }),
      addMarker: (fromFrame, opts) => {
        const marker: Marker = {
          id: uid('mk'),
          scope: opts?.scope ?? 'project',
          itemId: opts?.itemId,
          fromFrame: Math.max(0, Math.round(fromFrame)),
          durationFrames: Math.max(0, Math.round(opts?.durationFrames ?? 0)),
          note: opts?.note ?? '',
          color: opts?.color ?? 'blue',
        };
        dispatch({ type: 'addMarker', marker });
        return marker.id;
      },
      updateMarker: (id, patch) => dispatch({ type: 'updateMarker', id, patch }),
      removeMarker: (id) => dispatch({ type: 'removeMarker', id }),
      setReframeKeyframe: (id, frame, focalPointX, focalPointY, magnification) => dispatch({ type: 'reframeKeyframe', id, frame, focalPointX, focalPointY, magnification }),
      removeReframeKeyframe: (id, frame) => dispatch({ type: 'removeReframeKeyframe', id, frame }),
      addTransition: (incomingItemId, type, durationInFrames) => dispatch({ type: 'addTransition', id: uid('tr'), incomingItemId, transType: type, durationInFrames }),
      setTransition: (id, patch) => dispatch({ type: 'setTransition', id, patch }),
      removeTransition: (id) => dispatch({ type: 'removeTransition', id }),
      duplicateItem: (id) => dispatch({ type: 'duplicate', id, newId: uid('item') }),
      removeItem: (id) => dispatch({ type: 'remove', id }),
      rippleDeleteItem: (id) => dispatch({ type: 'remove', id, ripple: true }),
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
    if (a.type === 'undo' || a.type === 'redo') return; // history is meaningless in a draft
    const next = projectReduce(doc, a);
    if (next !== doc) {
      doc = next;
      pending.push(a);
    }
  };
  return {
    commands: buildCommands(dispatch, () => doc),
    getState: () => activeTimeline(doc),
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
