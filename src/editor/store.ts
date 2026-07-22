import { useMemo, useReducer, useRef } from 'react';
import type { AspectFit, ClipEffect, ClipFilters, ClipTransform, DesignStyle, KeyframeEasing, KeyframeProp, Marker, MediaAsset, ProjectDoc, Timeline, TimelineState, TrackFlags, TrackId, TrackKind, TrackUpdate, TransitionItem, TransitionType, Watermark, ZoomEffect } from './types';
import { activeEditorState, activeTimeline, defaultTrackId, resolveTrackId } from './types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';
import type { CaptionsData } from '../captions/types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import type { TranscriptWord, TranscriptVariant } from '../transcript/types';
import type { AnyAction, AtomicAction, ProjectDispatch } from './reduce';
import { historyReduce, maxOrder, projectReduce } from './reduce';

// Re-export the reducer layer so existing importers (`from './editor/store'`) keep working.
export type { Action, AnyAction, AtomicAction, BatchAction, ProjectAction, Dispatch, ProjectDispatch } from './reduce';
export { reduce, projectReduce } from './reduce';

// Ids must stay unique across sessions: items are persisted to IndexedDB, so a
// process-local counter (which resets to 0 on every reload) would regenerate ids
// that already exist and collide (e.g. split/duplicate reusing a live id →
// two items share an id → moveItem moves both). crypto.randomUUID avoids that.
const uid = (p: string) => `${p}_${crypto.randomUUID()}`;

export interface EditorCommands {
  addMotionGraphic: (tpl: Tpl, at?: { track?: TrackId; startFrame?: number; ripple?: boolean }) => void;
  addAudio: (asset: AudioAsset, at?: { track?: TrackId; startFrame?: number; ripple?: boolean }) => void;
  addAsset: (asset: MediaAsset) => void;
  addMediaItem: (asset: MediaAsset, at?: { track?: TrackId; startFrame?: number; ripple?: boolean }) => string;
  createMediaFolder: (name: string, parentId?: string) => string;
  renameMediaFolder: (id: string, name: string) => void;
  deleteMediaFolder: (id: string) => void;
  moveMediaAssets: (ids: string[], folderId?: string) => void;
  renameMediaAsset: (id: string, name: string) => void;
  setMediaAssetFavorite: (id: string, favorite: boolean) => void;
  /** Edit a library asset in place: rename / re-code (MG) / props / favorite. */
  editMediaAsset: (id: string, patch: Partial<Pick<MediaAsset, 'name' | 'code' | 'props' | 'favorite' | 'src' | 'durationInFrames' | 'width' | 'height' | 'kind'>>) => void;
  /** Remove a library asset from the media pool. */
  removeMediaAsset: (id: string) => void;
  /**
   * Relink missing or offline media.
   * Updates the pool asset and every timeline clip that still points at the old src.
   */
  relinkMediaAsset: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind'] }) => void;
  /** Solid-color item on a video track. */
  addSolidItem: (at?: { track?: TrackId; startFrame?: number; durationInFrames?: number; color?: string; name?: string }) => void;
  addTextClip: (at?: { track?: TrackId; startFrame?: number; durationInFrames?: number; ripple?: boolean }) => void;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  moveItem: (id: string, to: { track?: TrackId; startFrame?: number }) => void;
  setItemTiming: (id: string, timing: { startFrame?: number; durationInFrames?: number; srcInFrame?: number; ripple?: boolean }) => void;
  setItemVolume: (id: string, volume: number) => void;
  setItemFade: (id: string, fade: { fadeInFrames?: number; fadeOutFrames?: number }) => void;
  setItemTransform: (id: string, patch: ClipTransform) => void;
  setItemFilters: (id: string, patch: ClipFilters) => void;
  setItemZoom: (id: string, patch: Partial<ZoomEffect> | null) => void;
  /** Replace a clip's per-clip WebGL effect stack. */
  setItemEffects: (id: string, effects: ClipEffect[], defs?: SerializableFxDef[]) => void;
  /** Set playback speed and retime the clip while preserving its media span. */
  setItemSpeed: (id: string, rate: number) => void;
  /** replace a clip (MG/text) with a baked video at src, keeping its slot (转为视频) */
  replaceItemMedia: (id: string, src: string) => void;
  /** Add a ruler/clip marker at a frame and return its id. */
  addMarker: (fromFrame: number, opts?: { note?: string; color?: Marker['color']; durationFrames?: number; scope?: Marker['scope']; itemId?: string }) => string;
  updateMarker: (id: string, patch: Partial<Marker>) => void;
  removeMarker: (id: string) => void;
  setReframeKeyframe: (id: string, frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  removeReframeKeyframe: (id: string, frame: number) => void;
  /** set/update one generic transform keyframe at an item-local frame (PRD §4.5 钢笔工具) */
  setItemKeyframe: (id: string, prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  removeItemKeyframe: (id: string, prop: KeyframeProp, frame: number) => void;
  /** clear one prop's generic keyframes, or all of them when prop omitted */
  clearItemKeyframes: (id: string, prop?: KeyframeProp) => void;
  addTransition: (incomingItemId: string, type: TransitionType, durationInFrames?: number, custom?: { frag: string; uniforms: Record<string, number>; label: string }) => string;
  setTransition: (id: string, patch: Partial<TransitionItem>) => void;
  removeTransition: (id: string) => void;
  duplicateItem: (id: string) => void;
  removeItem: (id: string) => void;
  /** ripple delete: remove a clip AND close the gap (shift later same-track clips left) */
  rippleDeleteItem: (id: string) => void;
  splitItem: (id: string, atFrame: number) => void;
  clearTimeline: () => void;
  setAspect: (width: number, height: number, fit?: AspectFit) => void;
  toggleTrackFlag: (track: TrackId, flag: 'hidden' | 'muted' | 'collapsed' | 'locked') => void;
  createTrack: (kind: TrackKind, opts?: { name?: string; role?: TrackFlags['role']; order?: number; audioRouting?: TrackFlags['audioRouting'] }) => TrackId;
  updateTrack: (track: TrackId, patch: TrackUpdate) => void;
  deleteTracks: (tracks: TrackId[]) => void;
  tightenTrack: (track: TrackId) => void;
  setCaptions: (captions: CaptionsData | null, track?: TrackId) => void;
  updateCaptions: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  /** Toggle/configure the text watermark overlay with a partial, undoable update. */
  updateWatermark: (patch: Partial<Watermark>) => void;
  setItemTranscript: (id: string, words: TranscriptWord[]) => void;
  /** Ingest an ASR result into a pool asset. Clips created from the asset
   * inherit its transcript at placement; status/error drive the media-pool badge. */
  setAssetTranscription: (id: string, patch: Partial<Pick<MediaAsset, 'transcript' | 'transcribeStatus' | 'transcribeError'>>) => void;
  /** replace a clip's text-only transcript variants (translations / corrections) */
  setItemVariants: (id: string, variants: TranscriptVariant[]) => void;
  toggleWord: (id: string, idx: number) => void;
  deleteWords: (id: string, idxs: number[]) => void;
  cleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean; gapCapsMs?: Record<string, number>; replaceGapCaps?: boolean }) => void;
  /** Cap/delete one breath gap before word `afterWordIndex` (maxMs=null clears override). */
  setGapCap: (id: string, afterWordIndex: number, maxMs: number | null) => void;
  /** Speech-block drag: playback order of source word indices (null = chronological). */
  setTranscriptPlayOrder: (id: string, playOrder: number[] | null) => void;
  /** Clip drag in 文字稿: pack items on track in this id order. */
  reorderTrackItems: (track: string, orderedIds: string[]) => void;
  clearEdits: (id: string) => void;
  /** 改错字:只修正第 wordIndex 个转写词的 text,timing/词数/片段时长全不变。 */
  fixTranscriptWord: (id: string, wordIndex: number, text: string) => void;
  /** 说话人重命名/合并:把 speaker===from 的词全部改标 to;只改 .speaker。 */
  renameSpeaker: (id: string, from: string, to: string) => void;
  /** AI 人声隔离：挂上/清除 denoisedSrc。 */
  setItemDenoise: (id: string, denoisedSrc: string | null, strength?: number | null) => void;
  /** Select one clip. mode: replace (default) | toggle (⌘/Ctrl) | add. */
  selectItem: (id: string | null, opts?: { mode?: 'replace' | 'toggle' | 'add' }) => void;
  /** Replace multi-selection (e.g. shift-range). */
  selectItems: (ids: string[]) => void;
  /** Select every clip on the active timeline (⌘A). */
  selectAll: () => void;
  /** atomically replace the whole timeline (proposal apply → one undo step) */
  applyState: (state: TimelineState) => void;
  /** atomically replace the whole project (project-level proposal apply → one undo step) */
  applyDoc: (doc: ProjectDoc) => void;
  /** Execute multiple reducer operations as one undo/redo history entry. */
  batch: (actions: AtomicAction[], label?: string) => void;
  // ── Multiple timelines ──────────────────────────────────────────────────
  /** add a new empty timeline (inherits the active canvas unless sized); returns its id */
  createTimeline: (opts?: { name?: string; width?: number; height?: number; fit?: AspectFit; activate?: boolean }) => string;
  /** make a timeline active (no history step) */
  switchTimeline: (id: string) => void;
  /** copy a timeline (optionally retargeting the canvas for long→short); returns the copy's id */
  duplicateTimeline: (id: string, opts?: { name?: string; retarget?: { width: number; height: number; fit?: AspectFit }; activate?: boolean }) => string;
  deleteTimeline: (id: string) => void;
  renameTimeline: (id: string, name: string) => void;
  retargetTimeline: (id: string, width: number, height: number, fit?: AspectFit) => void;
  /** Hide/restore a timeline tab; the last visible one cannot be hidden. */
  setTimelineHidden: (id: string, hidden: boolean) => void;
  // ── Design style = project brand ────────────────────────────────────────
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
  // Timeline commands need the current project for timeline counts and ids;
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
    const existing = resolveTrackId(state, ref, kind) ?? defaultTrackId(state, kind);
    if (existing) return existing;
    const id = uid('track');
    dispatch({ type: 'track.create', track: { id, kind } });
    return id;
  };
  return {
      createTimeline: (opts) => {
        const d = getDoc();
        const base = activeTimeline(d);
        const trackOrder = [uid('track')];
        const t: Timeline = {
          fps: base.fps,
          width: opts?.width ?? base.width,
          height: opts?.height ?? base.height,
          fit: opts?.fit ?? base.fit,
          items: [], selectedId: null, trackOrder,
          tracks: { [trackOrder[0]]: { kind: 'video' } },
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
      batch: (actions, label) => {
        if (actions.length) dispatch({ type: 'batch', actions, label });
      },
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
      editMediaAsset: (id, patch) => dispatch({ type: 'pool.updateAsset', id, patch }),
      removeMediaAsset: (id) => dispatch({ type: 'pool.removeAsset', id }),
      relinkMediaAsset: (id, next) => dispatch({ type: 'pool.relinkAsset', id, ...next }),
      addSolidItem: (at) => {
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          item: {
            id: uid('item'),
            track: pickTrack(at?.track, 'video'),
            durationInFrames: at?.durationInFrames ?? Math.round(5 * 30),
            kind: 'solid',
            name: at?.name ?? '纯色',
            width: 1920,
            height: 1080,
            props: { color: at?.color ?? '#1a1a1a' },
          },
        });
      },
      setDesignStyle: (style) => dispatch({ type: 'design.set', style }),
      patchDesignStyle: (patch) => dispatch({ type: 'design.patch', patch }),
      addMotionGraphic: (tpl, at) =>
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
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
          ripple: at?.ripple,
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
      addMediaItem: (asset, at) => {
        const item = asset.kind === 'motion-graphic'
          ? {
              id: uid('item'),
              track: pickTrack(at?.track, 'video'),
              durationInFrames: asset.durationInFrames,
              kind: 'motion-graphic' as const,
              templateId: asset.id,
              name: asset.name,
              code: asset.code,
              props: { ...asset.props },
              width: asset.width,
              height: asset.height,
            }
          : {
              id: uid('item'),
              track: pickTrack(at?.track, asset.kind === 'audio' ? 'audio' : 'video'),
              durationInFrames: asset.durationInFrames,
              kind: asset.kind as Exclude<typeof asset.kind, 'motion-graphic'>,
              name: asset.name,
              src: asset.src,
              volume: asset.kind === 'audio' || asset.kind === 'video' ? 1 : undefined,
              width: asset.width,
              height: asset.height,
              // A clip inherits a copy of the asset's ingest transcript,
              // so per-clip word edits never mutate the asset master.
              transcript: asset.transcript?.length ? [...asset.transcript] : undefined,
            };
        dispatch({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
          item,
        });
        return item.id;
      },
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
      setItemEffects: (id, effects, defs) => dispatch({ type: 'setEffects', id, effects, defs }),
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
      setItemKeyframe: (id, prop, frame, value, easing) => dispatch({ type: 'setKeyframe', id, prop, frame, value, easing }),
      removeItemKeyframe: (id, prop, frame) => dispatch({ type: 'removeKeyframe', id, prop, frame }),
      clearItemKeyframes: (id, prop) => dispatch({ type: 'clearKeyframes', id, prop }),
      addTransition: (incomingItemId, type, durationInFrames, custom) => {
        const id = uid('tr');
        dispatch({ type: 'addTransition', id, incomingItemId, transType: type, durationInFrames, custom });
        return id;
      },
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
      setCaptions: (captions, track) => {
        const state = activeTimeline(getDoc());
        const target = track ?? defaultTrackId(state, 'caption') ?? undefined;
        if (!captions || target) {
          dispatch({ type: 'setCaptions', captions, track: target });
          return;
        }
        const id = uid('track');
        dispatch({
          type: 'batch',
          label: 'Create caption track',
          actions: [
            { type: 'track.create', track: { id, kind: 'caption' } },
            { type: 'setCaptions', captions, track: id },
          ],
        });
      },
      updateCaptions: (patch, track) => dispatch({ type: 'updateCaptions', patch, track }),
      updateWatermark: (patch) => dispatch({ type: 'updateWatermark', patch }),
      setItemTranscript: (id, words) => dispatch({ type: 'setItemTranscript', id, words }),
      setAssetTranscription: (id, patch) => dispatch({ type: 'pool.setTranscription', id, patch }),
      setItemVariants: (id, variants) => dispatch({ type: 'setItemVariants', id, variants }),
      toggleWord: (id, idx) => dispatch({ type: 'toggleWord', id, idx }),
      deleteWords: (id, idxs) => dispatch({ type: 'deleteWords', id, idxs }),
      cleanScript: (id, opts) => dispatch({
        type: 'cleanScript',
        id,
        silenceFrames: opts.silenceFrames,
        removeFillers: opts.removeFillers,
        gapCapsMs: opts.gapCapsMs,
        replaceGapCaps: opts.replaceGapCaps,
      }),
      setGapCap: (id, afterWordIndex, maxMs) => dispatch({ type: 'setGapCap', id, afterWordIndex, maxMs }),
      setTranscriptPlayOrder: (id, playOrder) => dispatch({ type: 'setTranscriptPlayOrder', id, playOrder }),
      reorderTrackItems: (track, orderedIds) => dispatch({ type: 'reorderTrackItems', track, orderedIds }),
      clearEdits: (id) => dispatch({ type: 'clearEdits', id }),
      fixTranscriptWord: (id, wordIndex, text) => dispatch({ type: 'fixTranscriptWord', id, wordIndex, text }),
      renameSpeaker: (id, from, to) => dispatch({ type: 'renameSpeaker', id, from, to }),
      setItemDenoise: (id, denoisedSrc, strength) => dispatch({ type: 'setItemDenoise', id, denoisedSrc, strength }),
      selectItem: (id, opts) => dispatch({ type: 'select', id, mode: opts?.mode }),
      selectItems: (ids) => dispatch({ type: 'selectMany', ids }),
      selectAll: () => dispatch({ type: 'selectAll' }),
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
