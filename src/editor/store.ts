import { useMemo, useReducer, useRef } from 'react';
import type { AspectFit, ClipEffect, ClipFilters, ClipTransform, DesignStyle, Marker, MediaAsset, ProjectDoc, Timeline, TimelineState, TrackFlags, TrackId, TrackKind, TrackUpdate, TransitionItem, TransitionType, ZoomEffect } from './types';
import { activeEditorState, activeTimeline, defaultTrackId, resolveTrackId } from './types';
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
  createMediaFolder: (name: string, parentId?: string) => string;
  renameMediaFolder: (id: string, name: string) => void;
  deleteMediaFolder: (id: string) => void;
  moveMediaAssets: (ids: string[], folderId?: string) => void;
  renameMediaAsset: (id: string, name: string) => void;
  setMediaAssetFavorite: (id: string, favorite: boolean) => void;
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
  /** replace a clip (MG/text) with a baked video at src, keeping its slot (转为视频) */
  replaceItemMedia: (id: string, src: string) => void;
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
  toggleTrackFlag: (track: TrackId, flag: 'hidden' | 'muted' | 'collapsed') => void;
  createTrack: (kind: TrackKind, opts?: { name?: string; role?: TrackFlags['role']; order?: number; audioRouting?: TrackFlags['audioRouting'] }) => TrackId;
  updateTrack: (track: TrackId, patch: TrackUpdate) => void;
  deleteTracks: (tracks: TrackId[]) => void;
  tightenTrack: (track: TrackId) => void;
  setCaptions: (captions: CaptionsData | null) => void;
  updateCaptions: (patch: Partial<CaptionsData>) => void;
  setItemTranscript: (id: string, words: TranscriptWord[]) => void;
  toggleWord: (id: string, idx: number) => void;
  deleteWords: (id: string, idxs: number[]) => void;
  cleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  clearEdits: (id: string) => void;
  /** 改错字:只修正第 wordIndex 个转写词的 text,timing/词数/片段时长全不变(护城河③) */
  fixTranscriptWord: (id: string, wordIndex: number, text: string) => void;
  /** 说话人重命名/合并:把 speaker===from 的词全部改标 to;只改 .speaker(护城河③) */
  renameSpeaker: (id: string, from: string, to: string) => void;
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
  // ── design style = project brand (source manage_design_style) ──
  /** apply a whole design style to the project (null clears it) */
  setDesignStyle: (style: DesignStyle | null) => void;
  /** merge a partial design style into the current one */
  patchDesignStyle: (patch: Partial<DesignStyle>) => void;
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

  return { state: activeEditorState(doc), doc, commands, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

// The editor command set over a project dispatch fn — reused by the live store
// (real dispatch → history) and by the proposal draft engine (draft dispatch
// that records + applies to a scratch ProjectDoc without touching the real one).
function buildCommands(dispatch: ProjectDispatch, getDoc: () => ProjectDoc): EditorCommands {
  const pickTrack = (ref: TrackId | undefined, kind: TrackKind): TrackId => {
    const state = activeTimeline(getDoc());
    return resolveTrackId(state, ref, kind) ?? defaultTrackId(state, kind) ?? (kind === 'video' ? 'V1' : 'A1');
  };
  return {
      createTimeline: (opts) => {
        const d = getDoc();
        const base = activeTimeline(d);
        const trackOrder = [uid('track'), uid('track'), uid('track'), uid('track')];
        const t: Timeline = {
          fps: base.fps,
          width: opts?.width ?? base.width,
          height: opts?.height ?? base.height,
          fit: opts?.fit ?? base.fit,
          items: [], selectedId: null, trackOrder,
          tracks: {
            [trackOrder[0]]: { kind: 'video' }, [trackOrder[1]]: { kind: 'video' },
            [trackOrder[2]]: { kind: 'audio' }, [trackOrder[3]]: { kind: 'audio' },
          },
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
      createMediaFolder: (name, parentId) => {
        const existing = getDoc().mediaFolders.find((folder) => folder.parentId === parentId && folder.name === name);
        if (existing) return existing.id;
        const id = uid('bin');
        dispatch({ type: 'pool.createFolder', folder: { id, name, parentId } });
        return id;
      },
      renameMediaFolder: (id, name) => dispatch({ type: 'pool.renameFolder', id, name }),
      deleteMediaFolder: (id) => dispatch({ type: 'pool.deleteFolder', id }),
      moveMediaAssets: (ids, folderId) => dispatch({ type: 'pool.moveAssets', ids, folderId }),
      renameMediaAsset: (id, name) => dispatch({ type: 'pool.updateAsset', id, patch: { name } }),
      setMediaAssetFavorite: (id, favorite) => dispatch({ type: 'pool.updateAsset', id, patch: { favorite } }),
      setDesignStyle: (style) => dispatch({ type: 'design.set', style }),
      patchDesignStyle: (patch) => dispatch({ type: 'design.patch', patch }),
      addMotionGraphic: (tpl, at) =>
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          item: {
            id: uid('item'),
            track: pickTrack(at?.track, 'video'),
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
            track: pickTrack(at?.track, 'audio'),
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
            track: pickTrack(at?.track ?? 'V2', 'video'), // titles default to the top video track
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
            track: pickTrack(at?.track, asset.kind === 'audio' ? 'audio' : 'video'),
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
      moveItem: (id, to) => {
        const item = activeTimeline(getDoc()).items.find((candidate) => candidate.id === id);
        const track = to.track && item ? pickTrack(to.track, item.kind === 'audio' ? 'audio' : 'video') : to.track;
        dispatch({ type: 'move', id, ...to, track });
      },
      setItemTiming: (id, timing) => dispatch({ type: 'retime', id, ...timing }),
      setItemVolume: (id, volume) => dispatch({ type: 'setVolume', id, volume }),
      setItemFade: (id, fade) => dispatch({ type: 'setFade', id, ...fade }),
      setItemTransform: (id, patch) => dispatch({ type: 'setTransform', id, patch }),
      setItemFilters: (id, patch) => dispatch({ type: 'setFilters', id, patch }),
      setItemZoom: (id, patch) => dispatch({ type: 'setZoom', id, patch }),
      setItemEffects: (id, effects) => dispatch({ type: 'setEffects', id, effects }),
      setItemSpeed: (id, rate) => dispatch({ type: 'setSpeed', id, rate }),
      replaceItemMedia: (id, src) => dispatch({ type: 'replaceMedia', id, src }),
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
      createTrack: (kind, opts) => {
        const id = uid('track');
        dispatch({ type: 'track.create', track: { id, kind, name: opts?.name, role: opts?.role, audioRouting: opts?.audioRouting }, order: opts?.order });
        return id;
      },
      updateTrack: (track, patch) => dispatch({ type: 'track.update', track, patch }),
      deleteTracks: (tracks) => dispatch({ type: 'track.delete', tracks }),
      tightenTrack: (track) => dispatch({ type: 'track.tighten', track }),
      setCaptions: (captions) => dispatch({ type: 'setCaptions', captions }),
      updateCaptions: (patch) => dispatch({ type: 'updateCaptions', patch }),
      setItemTranscript: (id, words) => dispatch({ type: 'setItemTranscript', id, words }),
      toggleWord: (id, idx) => dispatch({ type: 'toggleWord', id, idx }),
      deleteWords: (id, idxs) => dispatch({ type: 'deleteWords', id, idxs }),
      cleanScript: (id, opts) => dispatch({ type: 'cleanScript', id, silenceFrames: opts.silenceFrames, removeFillers: opts.removeFillers }),
      clearEdits: (id) => dispatch({ type: 'clearEdits', id }),
      fixTranscriptWord: (id, wordIndex, text) => dispatch({ type: 'fixTranscriptWord', id, wordIndex, text }),
      renameSpeaker: (id, from, to) => dispatch({ type: 'renameSpeaker', id, from, to }),
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
