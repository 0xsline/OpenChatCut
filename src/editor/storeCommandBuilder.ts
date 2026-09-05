import { copyTranscriptIdentity } from '../transcript/identity';
import type { AtomicAction, ProjectDispatch } from './reduce';
import { maxOrder, projectReduce } from './reduce';
import { sourceRevisionOf } from './mediaSourceRevision';
import { isTimelineMediaAssetKind } from './mediaTypes';
import { planOverwrite } from './overwrite';
import {
  resolveTimelineRenderPlan,
  sequenceReferenceError,
} from './sequenceGraph';
import { planSlip } from './slip';
import { sourceFramesToTimelineFrames } from './sourceLimit';
import type { EditorCommands } from './storeCommands';
import {
  activeEditorState,
  activeTimeline,
  defaultTrackId,
  resolveTrackId,
} from './types';
import type {
  Marker,
  MediaAsset,
  MediaRelinkResult,
  ProjectDoc,
  Timeline,
  TimelineItem,
  TrackId,
  TrackKind,
} from './types';

// Ids must stay unique across sessions: items are persisted to IndexedDB, so a
// process-local counter (which resets to 0 on every reload) would regenerate ids
// that already exist and collide (e.g. split/duplicate reusing a live id →
// two items share an id → moveItem moves both). crypto.randomUUID avoids that.
const uid = (p: string) => `${p}_${crypto.randomUUID()}`;

// The editor command set over a project dispatch fn — reused by the live store
// (real dispatch → history) and by the proposal draft engine (draft dispatch
// that records + applies to a scratch ProjectDoc without touching the real one).
export function buildCommands(dispatch: ProjectDispatch, getDoc: () => ProjectDoc): EditorCommands {
  // Track creations produced while BUILDING an action (pickTrack runs inside
  // the item literal, before dispatch) are staged here and folded into the same
  // batch as that action, so "add audio to a project with no audio track" is
  // ONE undo step instead of two — previously the first undo removed the clip
  // and left an empty track behind.
  let pendingTrackCreates: AtomicAction[] = [];
  const takePendingTrackCreates = (): AtomicAction[] => {
    const pending = pendingTrackCreates;
    pendingTrackCreates = [];
    return pending;
  };
  /** dispatch that atomically includes any track created while building `action`. */
  const dispatchWithTracks = (action: AtomicAction, label: string): void => {
    const pending = takePendingTrackCreates();
    dispatch(pending.length ? { type: 'batch', label, actions: [...pending, action] } : action);
  };
  const pickTrack = (ref: TrackId | undefined, kind: TrackKind): TrackId => {
    const state = activeTimeline(getDoc());
    const existing = resolveTrackId(state, ref, kind) ?? defaultTrackId(state, kind);
    if (existing) return existing;
    const id = uid('track');
    // Staged, not dispatched: the enclosing command commits it with its own
    // action. Any command that does not use dispatchWithTracks/placeItem still
    // gets it flushed as part of its next batch.
    pendingTrackCreates.push({ type: 'track.create', track: { id, kind } });
    return id;
  };
  const placeItem = (
    item: Omit<TimelineItem, 'startFrame'>,
    at: { startFrame?: number; ripple?: boolean; overwrite?: boolean } | undefined,
    before: AtomicAction[] = [],
  ) => {
    // Any track created while building `item` must land in the SAME step.
    const trackCreates = takePendingTrackCreates();
    if (!at?.overwrite) {
      const add: AtomicAction = { type: 'add', item, startFrame: at?.startFrame, ripple: at?.ripple };
      const actions = [...trackCreates, ...before, add];
      dispatch(actions.length > 1 ? { type: 'batch', label: 'Add media', actions } : add);
      return;
    }
    const doc = getDoc();
    let state = { ...activeTimeline(doc), assets: doc.assets };
    // Fold the staged tracks into the state BEFORE planning: the overwrite plan
    // commits via setFullState, which would otherwise replace the timeline
    // without those tracks and leave the new item referencing a ghost track.
    for (const create of trackCreates) {
      if (create.type !== 'track.create' || state.tracks?.[create.track.id]) continue;
      state = {
        ...state,
        tracks: { ...state.tracks, [create.track.id]: create.track },
        trackOrder: [...(state.trackOrder ?? []), create.track.id],
      };
    }
    const plan = planOverwrite(state, item, at.startFrame ?? 0, () => uid('item'));
    if (plan) dispatch({ type: 'batch', label: 'Overwrite clip', actions: [...trackCreates, ...before, ...plan.actions] });
  };
  const commitRelink = (
    action: Extract<AtomicAction, { type: 'pool.relinkAsset' | 'relinkTimelineItem' }>,
  ): MediaRelinkResult => {
    const current = getDoc();
    if (projectReduce(current, action) === current) {
      return { ok: false, changed: false, reason: 'no-document-change' };
    }
    dispatch(action);
    return { ok: true, changed: true };
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
      renameMediaAssets: (entries) => dispatch({
        type: 'batch',
        actions: entries.map(({ id, name }) => ({ type: 'pool.updateAsset', id, patch: { name } })),
        label: 'Rename media',
      }),
      setMediaAssetFavorite: (id, favorite) => dispatch({ type: 'pool.updateAsset', id, patch: { favorite } }),
      setMediaAssetsFavorite: (ids, favorite) => dispatch({
        type: 'batch',
        actions: ids.map((id) => ({ type: 'pool.updateAsset', id, patch: { favorite } })),
        label: favorite ? 'Favorite media' : 'Unfavorite media',
      }),
      editMediaAsset: (id, patch) => dispatch({ type: 'pool.updateAsset', id, patch }),
      removeMediaAsset: (id) => dispatch({ type: 'pool.removeAsset', id }),
      removeMediaAssets: (ids) => dispatch({
        type: 'batch',
        actions: ids.map((id) => ({ type: 'pool.removeAsset', id })),
        label: 'Delete media',
      }),
      canonicalizeMediaAsset: (duplicateId, canonicalId) => dispatch({
        type: 'pool.canonicalizeAsset',
        duplicateId,
        canonicalId,
      }),
      relinkMediaAsset: (id, next) => commitRelink({ type: 'pool.relinkAsset', id, ...next }),
      relinkTimelineItem: (id, next) => commitRelink({ type: 'relinkTimelineItem', id, ...next }),
      addSolidItem: (at) => {
        const id = uid('item');
        dispatchWithTracks({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
          item: {
            id,
            track: pickTrack(at?.track, 'video'),
            durationInFrames: at?.durationInFrames ?? Math.round(5 * 30),
            kind: 'solid',
            name: at?.name ?? '纯色',
            width: 1920,
            height: 1080,
            props: { color: at?.color ?? '#1a1a1a' },
          },
        }, 'Add solid');
        return id;
      },
      setDesignStyle: (style) => dispatch({ type: 'design.set', style }),
      patchDesignStyle: (patch) => dispatch({ type: 'design.patch', patch }),
      addMotionGraphic: (tpl, at) => {
        const item = {
          id: uid('item'),
          track: pickTrack(at?.track, 'video'),
          durationInFrames: tpl.durationInFrames,
          kind: 'motion-graphic' as const,
          templateId: tpl.id,
          name: tpl.name,
          code: tpl.code,
          props: { ...tpl.props },
          width: tpl.width,
          height: tpl.height,
        };
        placeItem(item, at);
      },
      addAudio: (asset, at) => {
        const assets = getDoc().assets;
        const exact = assets.find((candidate) => candidate.kind === 'audio' && candidate.id === asset.id && candidate.src === asset.src);
        const sameSource = assets.filter((candidate) => candidate.kind === 'audio' && candidate.src === asset.src);
        const existing = exact ?? (sameSource.length === 1 ? sameSource[0] : undefined);
        const canonical: MediaAsset = existing ?? {
          id: assets.some((candidate) => candidate.id === asset.id) ? uid('asset') : asset.id,
          kind: 'audio',
          name: asset.name,
          sourceFilename: asset.src.split(/[?#]/, 1)[0]?.split('/').at(-1) || undefined,
          src: asset.src,
          durationInFrames: asset.durationInFrames,
        };
        const item = {
          id: uid('item'),
          track: pickTrack(at?.track, 'audio'),
          durationInFrames: asset.durationInFrames,
          kind: 'audio' as const,
          name: asset.name,
          src: asset.src,
          sourceAssetId: canonical.id,
          sourceRevision: sourceRevisionOf(canonical),
          sourceContentHash: canonical.sourceContentHash,
          sourceFilename: canonical.sourceFilename,
          originalFilePath: canonical.originalFilePath,
          volume: 1,
        };
        placeItem(item, at, existing ? [] : [{ type: 'addAsset', asset: canonical }]);
        return { itemId: item.id, sourceAssetId: canonical.id };
      },
      addTextClip: (at) => {
        const id = uid('item');
        const align = at?.align === 'left' || at?.align === 'right' ? at.align : 'center';
        dispatchWithTracks({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
          item: {
            id,
            track: pickTrack(at?.track ?? 'V2', 'video'), // titles default to the top video track
            durationInFrames: at?.durationInFrames ?? 90,
            kind: 'text',
            name: at?.name?.trim() || '文字',
            width: 1920,
            height: 1080,
            props: {
              text: at?.text?.trim() || '双击编辑文字',
              fontSize: typeof at?.fontSize === 'number' && Number.isFinite(at.fontSize) ? at.fontSize : 96,
              color: at?.color?.trim() || '#ffffff',
              fontWeight: typeof at?.fontWeight === 'number' && Number.isFinite(at.fontWeight) ? at.fontWeight : 700,
              align,
            },
          },
        }, 'Add title');
        return id;
      },
      addAsset: (asset: MediaAsset) => dispatch({ type: 'addAsset', asset }),
      addMediaItem: (asset, at) => {
        if (!isTimelineMediaAssetKind(asset.kind)) throw new Error(`${asset.name} is not timeline media`);
        const item = asset.kind === 'motion-graphic'
          ? {
              id: uid('item'),
              track: pickTrack(at?.track, 'video'),
              durationInFrames: asset.durationInFrames,
              kind: 'motion-graphic' as const,
              templateId: asset.id,
              sourceAssetId: asset.id,
              name: asset.name,
              sourceRevision: sourceRevisionOf(asset),
              sourceContentHash: asset.sourceContentHash,
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
              sourceAssetId: asset.id,
              name: asset.name,
              src: asset.src,
              sourceFilename: asset.sourceFilename,
              originalFilePath: asset.originalFilePath,
              sourceRevision: sourceRevisionOf(asset),
              sourceContentHash: asset.sourceContentHash,
              srcInFrame: typeof at?.srcInFrame === 'number'
                ? Math.max(0, Math.round(at.srcInFrame))
                : undefined,
              volume: asset.kind === 'audio' || asset.kind === 'video' ? 1 : undefined,
              width: asset.width,
              height: asset.height,
              // A clip inherits a copy of the asset's ingest transcript,
              // so per-clip word edits never mutate the asset master.
              ...copyTranscriptIdentity(asset),
            };
        placeItem(item, at);
        return item.id;
      },
      addSequence: (timelineId, at) => {
        const doc = getDoc();
        const owner = activeTimeline(doc);
        const referenceError = sequenceReferenceError(doc, owner.id, timelineId);
        if (referenceError) {
          return { ok: false, error: referenceError.message, sequenceError: referenceError.toJSON() };
        }
        const target = doc.timelines.find((timeline) => timeline.id === timelineId);
        if (!target) return { ok: false, error: `Cannot add missing timeline ${timelineId}` };
        const sourceDuration = resolveTimelineRenderPlan(doc, timelineId).durationInFrames;
        const sourceStartFrame = Math.max(0, Math.round(at?.sourceStartFrame ?? 0));
        const availableSourceFrames = Math.max(0, sourceDuration - sourceStartFrame);
        if (availableSourceFrames <= 0) {
          return { ok: false, error: `Timeline ${timelineId} has no source frames available from frame ${sourceStartFrame}` };
        }
        const requestedSourceFrames = Math.min(
          availableSourceFrames,
          Math.max(1, at?.sourceDurationInFrames ?? availableSourceFrames),
        );
        const playbackRate = Math.max(0.1, Math.min(8, at?.playbackRate ?? 1));
        const id = uid('item');
        dispatchWithTracks({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
          item: {
            id,
            track: pickTrack(at?.track, 'video'),
            durationInFrames: Math.max(1, Math.round(sourceFramesToTimelineFrames({ playbackRate }, requestedSourceFrames))),
            kind: 'sequence',
            timelineId,
            name: target.name,
            width: target.width,
            height: target.height,
            srcInFrame: sourceStartFrame,
            playbackRate,
          },
        }, 'Add sequence');
        return { ok: true, itemId: id };
      },
      updateItemProps: (id, patch) => dispatch({ type: 'updateProps', id, patch }),
      moveItem: (id, to) => {
        const item = activeTimeline(getDoc()).items.find((candidate) => candidate.id === id);
        const track = to.track && item ? pickTrack(to.track, item.kind === 'audio' ? 'audio' : 'video') : to.track;
        dispatchWithTracks({ type: 'move', id, ...to, track }, 'Move clip');
      },
      setItemTiming: (id, timing) => dispatch({ type: 'retime', id, ...timing }),
      slipItem: (id, deltaInFrames) => {
        const result = planSlip(activeEditorState(getDoc()), id, deltaInFrames);
        if (result.ok && Math.abs(result.appliedDeltaInFrames) >= 1e-6) {
          dispatch({ type: 'slip', id, deltaInFrames: result.appliedDeltaInFrames });
        }
        return result;
      },
      setItemVolume: (id, volume) => dispatch({ type: 'setVolume', id, volume }),
      setItemFade: (id, fade) => dispatch({ type: 'setFade', id, ...fade }),
      setItemTransform: (id, patch) => dispatch({ type: 'setTransform', id, patch }),
      setItemFilters: (id, patch) => dispatch({ type: 'setFilters', id, patch }),
      setItemBackgroundFill: (id, enabled, strength) => dispatch({ type: 'setBackgroundFill', id, enabled, strength }),
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
      createCaptionTrack: (captions, opts) => {
        const id = uid('track');
        dispatch({
          type: 'batch',
          label: 'Create caption track',
          actions: [
            { type: 'track.create', track: { id, kind: 'caption', name: opts?.name }, order: opts?.order },
            { type: 'setCaptions', captions, track: id },
          ],
        });
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
      setCaptionsHidden: (hidden) => dispatch({ type: 'setCaptionsHidden', hidden }),
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
      reorderTrackItems: (track, orderedIds, starts) => dispatch({ type: 'reorderTrackItems', track, orderedIds, starts }),
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
      beginHistoryGesture: () => dispatch({ type: 'history.beginGesture' }),
      endHistoryGesture: () => dispatch({ type: 'history.endGesture' }),
  };
}
