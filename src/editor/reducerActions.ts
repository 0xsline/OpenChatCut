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
  MediaFolder,
  ProjectDoc,
  Timeline,
  TimelineState,
  TimelineItem,
  TrackFlags,
  TrackId,
  TrackKind,
  TrackUpdate,
  TransitionItem,
  TransitionType,
  Watermark,
  ZoomEffect,
} from './types';
import type { CaptionsData } from '../captions/types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import type { TranscriptWord, TranscriptVariant } from '../transcript/types';

// ── command actions (these map 1:1 to the future agent tools) ─────────────
export type Action =
  | { type: 'add'; item: Omit<TimelineItem, 'startFrame'>; startFrame?: number; ripple?: boolean }
  | { type: 'updateProps'; id: string; patch: Record<string, unknown> }
  | ({ type: 'relinkTimelineItem'; id: string } & MediaAssetRelinkPatch)
  | { type: 'move'; id: string; track?: TrackId; startFrame?: number }
  | { type: 'retime'; id: string; startFrame?: number; durationInFrames?: number; srcInFrame?: number; ripple?: boolean }
  | { type: 'slip'; id: string; deltaInFrames: number }
  | { type: 'setVolume'; id: string; volume: number }
  | { type: 'setFade'; id: string; fadeInFrames?: number; fadeOutFrames?: number }
  | { type: 'setTransform'; id: string; patch: ClipTransform }
  | { type: 'setFilters'; id: string; patch: ClipFilters }
  | { type: 'setBackgroundFill'; id: string; enabled: boolean; strength?: number }
  | { type: 'setZoom'; id: string; patch: Partial<ZoomEffect> | null }
  | { type: 'setEffects'; id: string; effects: ClipEffect[]; defs?: SerializableFxDef[] }
  | { type: 'setSpeed'; id: string; rate: number }
  | { type: 'replaceMedia'; id: string; src: string }
  | { type: 'addMarker'; marker: Marker }
  | { type: 'updateMarker'; id: string; patch: Partial<Marker> }
  | { type: 'removeMarker'; id: string }
  | { type: 'reframeKeyframe'; id: string; frame: number; focalPointX: number; focalPointY: number; magnification: number }
  | { type: 'removeReframeKeyframe'; id: string; frame: number }
  // generic transform keyframes (PRD §4.5 Pen tool): frame = item-local edit frame
  | { type: 'setKeyframe'; id: string; prop: KeyframeProp; frame: number; value: number; easing?: KeyframeEasing }
  | { type: 'removeKeyframe'; id: string; prop: KeyframeProp; frame: number }
  | { type: 'clearKeyframes'; id: string; prop?: KeyframeProp }
  | { type: 'addTransition'; id: string; incomingItemId: string; transType: TransitionType; durationInFrames?: number; custom?: { frag: string; uniforms: Record<string, number>; label: string } }
  | { type: 'setTransition'; id: string; patch: Partial<TransitionItem> }
  | { type: 'removeTransition'; id: string }
  | { type: 'duplicate'; id: string; newId: string }
  | { type: 'remove'; id: string; ripple?: boolean }
  | { type: 'split'; id: string; atFrame: number; newId: string }
  | { type: 'clear' }
  | { type: 'addAsset'; asset: MediaAsset }
  | { type: 'setCanvas'; width: number; height: number; fit?: AspectFit }
  | { type: 'toggleTrack'; track: TrackId; flag: 'hidden' | 'muted' | 'collapsed' | 'locked' }
  | { type: 'track.create'; track: { id: TrackId; kind: TrackKind; name?: string; role?: TrackFlags['role']; audioRouting?: TrackFlags['audioRouting'] }; order?: number }
  | { type: 'track.update'; track: TrackId; patch: TrackUpdate }
  | { type: 'track.delete'; tracks: TrackId[] }
  | { type: 'track.tighten'; track: TrackId }
  | { type: 'setCaptions'; captions: CaptionsData | null; track?: TrackId }
  | { type: 'updateCaptions'; patch: Partial<CaptionsData>; track?: TrackId }
  | { type: 'setCaptionsHidden'; hidden: boolean }
  | { type: 'updateWatermark'; patch: Partial<Watermark> }
  | { type: 'setItemTranscript'; id: string; words: TranscriptWord[] }
  | { type: 'setItemVariants'; id: string; variants: TranscriptVariant[] }
  | { type: 'toggleWord'; id: string; idx: number }
  | { type: 'deleteWords'; id: string; idxs: number[] }
  | { type: 'cleanScript'; id: string; silenceFrames?: number; cutPadFrames?: number; removeFillers: boolean; gapCapsMs?: Record<string, number>; replaceGapCaps?: boolean }
  /** Per-gap silence cap. afterWordIndex = word after the gap; maxMs=null clears the override. */
  | { type: 'setGapCap'; id: string; afterWordIndex: number; maxMs: number | null }
  /** Speech-block drag: playback order of source word indices (null clears → chronological). */
  | { type: 'setTranscriptPlayOrder'; id: string; playOrder: number[] | null }
  /** Pack items on a track in the given id order (clip drag in script).
   * `starts` (optional) pins explicit absolute start frames — used by
   * apply_script repack for gap-aware, atomic reordering that must not be
   * rejected by the same-track overlap guard (single dispatch, no intermediate
   * overlapping state). Without `starts`, items pack tightly from the earliest
   * start of the reordered set (existing behavior). */
  | { type: 'reorderTrackItems'; track: string; orderedIds: string[]; starts?: Record<string, number> }
  | { type: 'clearEdits'; id: string }
  | { type: 'fixTranscriptWord'; id: string; wordIndex: number; text: string }
  | { type: 'renameSpeaker'; id: string; from: string; to: string }
  /** AI Voice Isolation attach/clear (isolate_voice → denoisedAudioAssetId). */
  | { type: 'setItemDenoise'; id: string; denoisedSrc: string | null; strength?: number | null }
  | { type: 'select'; id: string | null; mode?: 'replace' | 'toggle' | 'add' }
  | { type: 'selectMany'; ids: string[] }
  | { type: 'selectAll' }
  | { type: 'setFullState'; state: TimelineState };

export const TRANSITION_RECONCILING_ACTIONS = new Set<Action['type']>([
  'add', 'move', 'retime', 'slip', 'setSpeed', 'replaceMedia', 'relinkTimelineItem', 'duplicate', 'remove', 'split', 'clear',
  'track.tighten', 'toggleWord', 'deleteWords', 'cleanScript', 'setGapCap',
  'setTranscriptPlayOrder', 'reorderTrackItems', 'clearEdits', 'addTransition',
  'setTransition', 'setFullState',
]);

// ── Project-level actions for multiple timelines ──────────────────────────
// These operate on the ProjectDoc (the set of timelines), not on any single
// timeline's items. All per-timeline Actions above are routed to the active
// timeline by projectReduce.
export type ProjectAction =
  | { type: 'tl.create'; timeline: Timeline; activate?: boolean }
  | { type: 'tl.switch'; id: string }
  | { type: 'tl.duplicate'; id: string; newId: string; name: string; retarget?: { width: number; height: number; fit?: AspectFit }; activate?: boolean }
  | { type: 'tl.delete'; id: string }
  | { type: 'tl.rename'; id: string; name: string }
  | { type: 'tl.retarget'; id: string; width: number; height: number; fit?: AspectFit }
  | { type: 'tl.setHidden'; id: string; hidden: boolean }
  | { type: 'tl.setDoc'; doc: ProjectDoc }
  | { type: 'pool.createFolder'; folder: MediaFolder }
  | { type: 'pool.renameFolder'; id: string; name: string }
  | { type: 'pool.deleteFolder'; id: string }
  | { type: 'pool.moveAssets'; ids: string[]; folderId?: string }
  | { type: 'pool.updateAsset'; id: string; patch: Partial<Pick<MediaAsset, 'name' | 'favorite' | 'code' | 'props' | 'sourceTimecode' | 'captureClock'>> }
  | { type: 'pool.setTranscription'; id: string; patch: Partial<Pick<MediaAsset, 'transcript' | 'transcriptSourceRevision' | 'transcriptStale' | 'transcribeStatus' | 'transcribeError'>> }
  | ({ type: 'pool.relinkAsset'; id: string } & MediaAssetRelinkPatch)
  | { type: 'pool.canonicalizeAsset'; duplicateId: string; canonicalId: string }
  | { type: 'pool.removeAsset'; id: string }
  | { type: 'design.set'; style: DesignStyle | null }
  | { type: 'design.patch'; patch: Partial<DesignStyle> };

/** One reducer operation before history grouping. */
export type AtomicAction = Action | ProjectAction;
/** Several reducer operations committed as one undo/redo history entry. */
export interface BatchAction {
  type: 'batch';
  actions: AtomicAction[];
  label?: string;
}
/** any store action: atomic or explicitly grouped (what a draft records) */
export type AnyAction = AtomicAction | BatchAction;
/**
 * Control actions of the history stack itself (without changing the document through the reducer): undo/redo, and the boundaries of continuous gestures
 *  — All changes between begin/end are merged into an undo record (drag the slider, drag the color picker).
 */
export type HistoryControlAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'history.beginGesture' }
  | { type: 'history.endGesture' };
/** History control action judgment (used for type narrowing: string prefix judgment will not narrow union types). */
export function isHistoryControlAction(a: { type: string }): a is HistoryControlAction {
  return a.type === 'undo' || a.type === 'redo'
    || a.type === 'history.beginGesture' || a.type === 'history.endGesture';
}

/** dispatch accepted by the command set: store actions + history control */
export type Dispatch = (a: Action | BatchAction | HistoryControlAction) => void;
/** dispatch at the project level: per-timeline + project actions + history control */
export type ProjectDispatch = (a: AnyAction | HistoryControlAction) => void;

export const MUTATING = new Set(['add', 'updateProps', 'relinkTimelineItem', 'move', 'retime', 'slip', 'setVolume', 'setFade', 'setTransform', 'setFilters', 'setZoom', 'setEffects', 'setSpeed', 'replaceMedia', 'reframeKeyframe', 'removeReframeKeyframe', 'setKeyframe', 'removeKeyframe', 'clearKeyframes', 'addTransition', 'setTransition', 'removeTransition', 'addMarker', 'updateMarker', 'removeMarker', 'duplicate', 'remove', 'split', 'clear', 'addAsset', 'setCanvas', 'toggleTrack', 'track.create', 'track.update', 'track.delete', 'track.tighten', 'setCaptions', 'updateCaptions', 'setCaptionsHidden', 'updateWatermark', 'setItemTranscript', 'setItemVariants', 'toggleWord', 'deleteWords', 'cleanScript', 'setGapCap', 'setTranscriptPlayOrder', 'reorderTrackItems', 'clearEdits', 'fixTranscriptWord', 'renameSpeaker', 'setItemDenoise', 'setFullState',
  // project-level (tl.switch is navigation → deliberately NOT here, so it makes no history step)
  'tl.create', 'tl.duplicate', 'tl.delete', 'tl.rename', 'tl.retarget', 'tl.setHidden', 'tl.setDoc',
  'pool.createFolder', 'pool.renameFolder', 'pool.deleteFolder', 'pool.moveAssets', 'pool.updateAsset', 'pool.setTranscription', 'pool.relinkAsset', 'pool.canonicalizeAsset', 'pool.removeAsset', 'design.set', 'design.patch', 'setBackgroundFill'])
