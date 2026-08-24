import type { AudioAsset } from '../audio/library';
import type { CaptionsData } from '../captions/types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import type { TranscriptWord, TranscriptVariant } from '../transcript/types';
import type { Tpl } from '../types';
import type { AtomicAction } from './reduce';
import type { SequenceGraphErrorDetails } from './sequenceGraph';
import type { SlipResult } from './slip';
import type {
  AspectFit,
  ClipEffect,
  ClipFilters,
  ClipTransform,
  DesignStyle,
  KeyframeEasing,
  KeyframeProp,
  Marker,
  MediaAsset,
  MediaAssetRelinkPatch,
  MediaRelinkResult,
  ProjectDoc,
  TimelineState,
  TrackFlags,
  TrackId,
  TrackKind,
  TrackUpdate,
  TransitionItem,
  TransitionType,
  Watermark,
  ZoomEffect,
} from './types';
export type AddSequenceResult =
  | { ok: true; itemId: string }
  | { ok: false; error: string; sequenceError?: SequenceGraphErrorDetails };

export interface AddAudioResult {
  itemId: string;
  sourceAssetId: string;
}

export interface EditorCommands {
  addMotionGraphic: (tpl: Tpl, at?: { track?: TrackId; startFrame?: number; ripple?: boolean; overwrite?: boolean }) => void;
  addAudio: (asset: AudioAsset, at?: { track?: TrackId; startFrame?: number; ripple?: boolean; overwrite?: boolean }) => AddAudioResult;
  addAsset: (asset: MediaAsset) => void;
  addMediaItem: (asset: MediaAsset, at?: { track?: TrackId; startFrame?: number; srcInFrame?: number; ripple?: boolean; overwrite?: boolean }) => string;
  /** Add an instance of another timeline without copying its contents. */
  addSequence: (timelineId: string, at?: {
    track?: TrackId;
    startFrame?: number;
    sourceStartFrame?: number;
    sourceDurationInFrames?: number;
    playbackRate?: number;
    ripple?: boolean;
  }) => AddSequenceResult;
  createMediaFolder: (name: string, parentId?: string) => string;
  renameMediaFolder: (id: string, name: string) => void;
  deleteMediaFolder: (id: string) => void;
  moveMediaAssets: (ids: string[], folderId?: string) => void;
  renameMediaAsset: (id: string, name: string) => void;
  renameMediaAssets: (entries: Array<{ id: string; name: string }>) => void;
  setMediaAssetFavorite: (id: string, favorite: boolean) => void;
  setMediaAssetsFavorite: (ids: string[], favorite: boolean) => void;
  /** Edit library metadata, code defaults, or exact ingest clocks. */
  editMediaAsset: (id: string, patch: Partial<Pick<MediaAsset, 'name' | 'code' | 'props' | 'favorite' | 'sourceTimecode' | 'captureClock'>>) => void;
  /** Remove a library asset from the media pool. */
  removeMediaAsset: (id: string) => void;
  /** Remove selected assets and all linked timeline references as one undoable action. */
  removeMediaAssets: (ids: string[]) => void;
  canonicalizeMediaAsset: (duplicateId: string, canonicalId: string) => void;
  /**
   * Relink missing or offline media.
   * Updates the pool asset and every timeline clip that still points at the old src.
   */
  relinkMediaAsset: (id: string, next: MediaAssetRelinkPatch) => MediaRelinkResult;
  /** Relink exactly one timeline item without changing its former pool master. */
  relinkTimelineItem: (id: string, next: MediaAssetRelinkPatch) => MediaRelinkResult;
  /** Solid-color item on a video track. Returns the new item id. */
  addSolidItem: (at?: {
    track?: TrackId;
    startFrame?: number;
    durationInFrames?: number;
    color?: string;
    name?: string;
    ripple?: boolean;
  }) => string;
  /** Authored text clip. Returns the new item id. */
  addTextClip: (at?: {
    track?: TrackId;
    startFrame?: number;
    durationInFrames?: number;
    ripple?: boolean;
    name?: string;
    text?: string;
    fontSize?: number;
    color?: string;
    fontWeight?: number;
    align?: 'left' | 'center' | 'right';
  }) => string;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  moveItem: (id: string, to: { track?: TrackId; startFrame?: number }) => void;
  setItemTiming: (id: string, timing: { startFrame?: number; durationInFrames?: number; srcInFrame?: number; ripple?: boolean }) => void;
  slipItem: (id: string, deltaInFrames: number) => SlipResult;
  setItemVolume: (id: string, volume: number) => void;
  setItemFade: (id: string, fade: { fadeInFrames?: number; fadeOutFrames?: number }) => void;
  setItemTransform: (id: string, patch: ClipTransform) => void;
  setItemFilters: (id: string, patch: ClipFilters) => void;
  setItemBackgroundFill: (id: string, enabled: boolean, strength?: number) => void;
  setItemZoom: (id: string, patch: Partial<ZoomEffect> | null) => void;
  /** Replace a clip's per-clip WebGL effect stack. */
  setItemEffects: (id: string, effects: ClipEffect[], defs?: SerializableFxDef[]) => void;
  /** Set playback speed and retime the clip while preserving its media span. */
  setItemSpeed: (id: string, rate: number) => void;
  /** replace a clip (MG/text) with a baked video at src, keeping its slot (convert to video)*/
  replaceItemMedia: (id: string, src: string) => void;
  /** Add a ruler/clip marker at a frame and return its id. */
  addMarker: (fromFrame: number, opts?: { note?: string; color?: Marker['color']; durationFrames?: number; scope?: Marker['scope']; itemId?: string }) => string;
  updateMarker: (id: string, patch: Partial<Marker>) => void;
  removeMarker: (id: string) => void;
  setReframeKeyframe: (id: string, frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  removeReframeKeyframe: (id: string, frame: number) => void;
  /** set/update one generic transform keyframe at an item-local frame (PRD §4.5 Pen tool)*/
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
  createCaptionTrack: (captions: CaptionsData, opts?: { name?: string; order?: number }) => TrackId;
  updateTrack: (track: TrackId, patch: TrackUpdate) => void;
  deleteTracks: (tracks: TrackId[]) => void;
  tightenTrack: (track: TrackId) => void;
  setCaptions: (captions: CaptionsData | null, track?: TrackId) => void;
  updateCaptions: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  /** Global caption-system switch: captions off also hides on-screen text clips. */
  setCaptionsHidden: (hidden: boolean) => void;
  /** Toggle/configure the text watermark overlay with a partial, undoable update. */
  updateWatermark: (patch: Partial<Watermark>) => void;
  setItemTranscript: (id: string, words: TranscriptWord[]) => void;
  /** Ingest an ASR result into a pool asset. Clips created from the asset
   * inherit its transcript at placement; status/error drive the media-pool badge. */
  setAssetTranscription: (id: string, patch: Partial<Pick<MediaAsset, 'transcript' | 'transcriptSourceRevision' | 'transcribeStatus' | 'transcribeError'>>) => void;
  /** replace a clip's text-only transcript variants (translations / corrections) */
  setItemVariants: (id: string, variants: TranscriptVariant[]) => void;
  toggleWord: (id: string, idx: number) => void;
  deleteWords: (id: string, idxs: number[]) => void;
  cleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean; gapCapsMs?: Record<string, number>; replaceGapCaps?: boolean }) => void;
  /** Cap/delete one breath gap before word `afterWordIndex` (maxMs=null clears override). */
  setGapCap: (id: string, afterWordIndex: number, maxMs: number | null) => void;
  /** Speech-block drag: playback order of source word indices (null = chronological). */
  setTranscriptPlayOrder: (id: string, playOrder: number[] | null) => void;
  /** Clip drag in transcript: pack items on track in this id order.
   * `starts` optionally pins explicit absolute frames (apply_script gap-aware repack).*/
  reorderTrackItems: (track: string, orderedIds: string[], starts?: Record<string, number>) => void;
  clearEdits: (id: string) => void;
  /** Correction of typos: Only the text of the wordIndex-th transliterated word is corrected, and the timing/number of words/segment duration remains unchanged.*/
  fixTranscriptWord: (id: string, wordIndex: number, text: string) => void;
  /** Speaker renaming/merging: Change all words with speaker===from to to; only change.speaker.*/
  renameSpeaker: (id: string, from: string, to: string) => void;
  /** AI vocal isolation: hang/clear denoisedSrc.*/
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
  /**
   * Boundaries for continuous gestures (drag the slider, drag the color picker). All changes between the two are merged into one undo record,
   * Undo goes back to "before dragging" instead of the previous tick. Press the pointer to adjust begin, release it to adjust end.
   */
  beginHistoryGesture: () => void;
  endHistoryGesture: () => void;
}
