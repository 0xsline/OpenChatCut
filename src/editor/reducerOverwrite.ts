import type { TimelineItem, TimelineState, TrackId } from './types';
import { selectedIdsOf } from './types';
import { fitItemToDuration } from './clipFit';
import { splitItemKeyframes } from './keyframes';
import { sourceWindowForTimelineRange } from './sourceLimit';
import { unlinkItems } from './linkGroups';
import { reconcileTimelineCaptionReferences, remapSplitTimelineCaptionReferences } from '../captions/reconcileSources';
import { reconcileTransitions } from './transitionReconcile';
import { hasOperationalTranscript } from '../transcript/types';
import { splitClipTranscript } from '../transcript/edit';
import type { Action } from './reducerActions';
import { retimePatchForItem, type OverwriteLaneAction } from './reducerTimelineHelpers';

export function splitTimelineItem(
  s: TimelineState,
  item: TimelineItem,
  atFrame: number,
  newId: string,
): [TimelineItem, TimelineItem] {
  const cut = atFrame - item.startFrame;
  const sourceWindow = sourceWindowForTimelineRange(item, 0, cut);
  // Word-driven audio partitions its already-edited word stream in visible timeline time.
  const wordDriven = item.kind === 'audio' && hasOperationalTranscript(item);
  const transcriptCut = wordDriven
    ? sourceWindowForTimelineRange({ ...item, playbackRate: 1 }, 0, cut).endFrame
    : sourceWindow.endFrame;
  const transcriptParts = hasOperationalTranscript(item)
    ? splitClipTranscript(item, s.fps, transcriptCut)
    : null;
  const keyframeParts = item.keyframes ? splitItemKeyframes(item.keyframes, cut) : null;
  const left: TimelineItem = {
    ...item,
    durationInFrames: cut,
    fadeOutFrames: undefined,
    ...(transcriptParts ? {
      transcript: transcriptParts.left.transcript,
      deletedWordIdx: transcriptParts.left.deletedWordIdx,
      variants: transcriptParts.left.variants,
      gapCapsMs: transcriptParts.left.gapCapsMs,
      transcriptPlayOrder: undefined,
    } : {}),
    ...(keyframeParts ? { keyframes: keyframeParts[0] } : {}),
  };
  const right: TimelineItem = {
    ...item,
    id: newId,
    startFrame: atFrame,
    durationInFrames: item.durationInFrames - cut,
    srcInFrame: wordDriven && transcriptParts ? 0 : sourceWindow.endFrame,
    fadeInFrames: undefined,
    ...(transcriptParts ? {
      transcript: transcriptParts.right.transcript,
      deletedWordIdx: transcriptParts.right.deletedWordIdx,
      variants: transcriptParts.right.variants,
      gapCapsMs: transcriptParts.right.gapCapsMs,
      transcriptPlayOrder: undefined,
    } : {}),
    ...(keyframeParts ? { keyframes: keyframeParts[1] } : {}),
  };
  return [fitItemToDuration(left), fitItemToDuration(right)];
}

/**
 * A split keeps the original id on the left fragment. Transitions entering the
 * clip therefore keep their incoming endpoint, while transitions leaving its
 * original right edge must follow the new right-fragment id.
 */
export function remapSplitTransitionEndpoints(
  transitions: TimelineState['transitions'],
  originalId: string,
  rightId: string,
): TimelineState['transitions'] {
  if (!transitions?.some((transition) => transition.outgoingItemId === originalId)) return transitions;
  return transitions.map((transition) => transition.outgoingItemId === originalId
    ? { ...transition, outgoingItemId: rightId }
    : transition);
}

function reconcileOverwriteLaneState(state: TimelineState): TimelineState {
  const reconciled = reconcileTimelineCaptionReferences(state);
  if (!reconciled.transitions?.length) return reconciled;
  return { ...reconciled, transitions: reconcileTransitions(reconciled.items, reconciled.transitions) };
}

function overwriteLaneTarget(
  state: TimelineState,
  targetTrackId: TrackId,
  id: string,
): TimelineItem | null {
  let target: TimelineItem | null = null;
  for (const item of state.items) {
    if (item.id !== id) continue;
    if (target) return null;
    target = item;
  }
  return target?.track === targetTrackId ? target : null;
}

/**
 * Apply one overwrite-planner operation to exactly one target lane.
 * Unlike user-facing remove/retime commands, this never follows link groups:
 * a changed target item is unlinked while every companion keeps its geometry.
 * Invalid or inapplicable operations reject instead of silently becoming no-ops.
 */
export function applyOverwriteLaneAction(
  state: TimelineState,
  targetTrackId: TrackId,
  action: OverwriteLaneAction,
): TimelineState | null {
  if (state.tracks?.[targetTrackId]?.locked) return null;

  switch (action.type) {
    case 'add': {
      const startFrame = action.startFrame;
      if (action.ripple || action.item.track !== targetTrackId || startFrame === undefined
        || !Number.isFinite(startFrame) || startFrame < 0
        || !Number.isFinite(action.item.durationInFrames) || action.item.durationInFrames < 1
        || state.items.some((item) => item.id === action.item.id)) return null;
      const endFrame = startFrame + action.item.durationInFrames;
      if (!Number.isFinite(endFrame)) return null;
      const overlapsTargetLane = state.items.some((item) => item.track === targetTrackId
        && item.startFrame < endFrame
        && item.startFrame + item.durationInFrames > startFrame);
      if (overlapsTargetLane) return null;
      const item = fitItemToDuration({ ...action.item, startFrame });
      if (item.startFrame !== startFrame || item.durationInFrames !== action.item.durationInFrames) return null;
      return reconcileOverwriteLaneState({
        ...state,
        items: [...state.items, item],
        selectedId: item.id,
        selectedIds: [item.id],
      });
    }
    case 'remove': {
      if (action.ripple) return null;
      const target = overwriteLaneTarget(state, targetTrackId, action.id);
      if (!target) return null;
      const remainingIds = new Set(state.items
        .filter((item) => item.id !== action.id)
        .map((item) => item.id));
      const selectedIds = selectedIdsOf(state).filter((id) => remainingIds.has(id));
      const removed = unlinkItems({
        ...state,
        items: state.items.filter((item) => item.id !== action.id),
        transitions: (state.transitions ?? []).filter((transition) =>
          transition.incomingItemId !== action.id && transition.outgoingItemId !== action.id),
        selectedIds,
        selectedId: selectedIds[selectedIds.length - 1] ?? null,
      }, [action.id]);
      return reconcileOverwriteLaneState(removed);
    }
    case 'retime': {
      if (action.ripple) return null;
      const target = overwriteLaneTarget(state, targetTrackId, action.id);
      if (!target) return null;
      const patch = retimePatchForItem(state, target, action);
      if (!Number.isFinite(patch.startFrame) || patch.startFrame < 0
        || !Number.isFinite(patch.durationInFrames) || patch.durationInFrames < 1
        || (patch.srcInFrame !== undefined && (!Number.isFinite(patch.srcInFrame) || patch.srcInFrame < 0))
        || (action.startFrame !== undefined && patch.startFrame !== action.startFrame)
        || (action.durationInFrames !== undefined && patch.durationInFrames !== action.durationInFrames)
        || (action.srcInFrame !== undefined && patch.srcInFrame !== action.srcInFrame)
        || (patch.startFrame === target.startFrame
          && patch.durationInFrames === target.durationInFrames
          && patch.srcInFrame === target.srcInFrame)) return null;
      const retimed = fitItemToDuration({ ...target, ...patch });
      const unlinked = unlinkItems({
        ...state,
        items: state.items.map((item) => item.id === target.id ? retimed : item),
      }, [target.id]);
      return reconcileOverwriteLaneState(unlinked);
    }
    case 'split': {
      const target = overwriteLaneTarget(state, targetTrackId, action.id);
      if (!target || !Number.isFinite(action.atFrame)
        || action.atFrame <= target.startFrame
        || action.atFrame >= target.startFrame + target.durationInFrames
        || state.items.some((item) => item.id === action.newId)) return null;
      const [left, right] = splitTimelineItem(state, target, action.atFrame, action.newId);
      if (left.startFrame !== target.startFrame
        || left.durationInFrames !== action.atFrame - target.startFrame
        || right.startFrame !== action.atFrame
        || right.durationInFrames !== target.startFrame + target.durationInFrames - action.atFrame) return null;
      const splitState = remapSplitTimelineCaptionReferences({
        ...state,
        items: state.items.flatMap((item) => item.id === target.id ? [left, right] : [item]),
        transitions: remapSplitTransitionEndpoints(state.transitions, target.id, right.id),
      }, target.id, right.id);
      const unlinked = unlinkItems(splitState, [target.id]);
      return reconcileOverwriteLaneState(unlinked);
    }
  }
}

export const OVERLAP_GUARDED_ACTIONS: ReadonlySet<Action['type']> = new Set([
  'add', 'relinkTimelineItem', 'move', 'retime', 'setSpeed', 'remove',
  'track.tighten', 'toggleWord', 'deleteWords', 'cleanScript', 'setGapCap',
  'setTranscriptPlayOrder', 'reorderTrackItems', 'clearEdits', 'setFullState',
]);
