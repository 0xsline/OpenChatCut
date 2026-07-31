// Multi-select ops: move / remove a set of clips as one undoable step.
// Used by timeline pointer (group drag), shortcuts (⌫), and clip context menu.
import {
  selectedIdsOf, timelineTrackIds, trackKind,
  type TimelineState, type TrackId,
} from './types';
import { moveLockedItemIds, removeItemsWithGroups } from './linkGroups';

/** Ids that should move together when dragging `primaryId` (the grab handle). */
export function groupMoveIds(state: TimelineState, primaryId: string): string[] {
  const ids = selectedIdsOf(state);
  const seeds = ids.includes(primaryId) && ids.length > 1 ? ids : [primaryId];
  return moveLockedItemIds(state, seeds);
}

/**
 * Shift a set of clips by the same frame delta; optional track index shift from
 * the primary clip's base track → target track (same-kind lanes only, skip locked).
 */
export function moveItemsByDelta(
  state: TimelineState,
  ids: string[],
  deltaF: number,
  trackShift: { from: TrackId; to: TrackId } | null,
): TimelineState {
  if (!ids.length) return state;
  const order = timelineTrackIds(state);
  const fromIdx = trackShift ? order.indexOf(trackShift.from) : -1;
  const toIdx = trackShift ? order.indexOf(trackShift.to) : -1;
  const dTrack = fromIdx >= 0 && toIdx >= 0 ? toIdx - fromIdx : 0;
  if (deltaF === 0 && dTrack === 0) return state;

  const idSet = new Set(moveLockedItemIds(state, ids));
  const moving = state.items.filter((item) => idSet.has(item.id));
  if (moving.some((item) => state.tracks?.[item.track]?.locked)) return state;
  const earliest = Math.min(...moving.map((item) => item.startFrame));
  const sharedDelta = Math.max(deltaF, -earliest);
  const items = state.items.map((it) => {
    if (!idSet.has(it.id)) return it;
    let track = it.track;
    if (dTrack !== 0) {
      const ni = order.indexOf(it.track) + dTrack;
      if (ni >= 0 && ni < order.length) {
        const candidate = order[ni]!;
        if (
          trackKind(state, candidate) === trackKind(state, it.track)
          && !state.tracks?.[candidate]?.locked
        ) {
          track = candidate;
        }
      }
    }
    return { ...it, startFrame: it.startFrame + sharedDelta, track };
  });
  return { ...state, items };
}

/** Remove many clips; optional ripple close-gap per clip (reverse chrono so indices stay valid). */
export function removeItemsFromState(
  state: TimelineState,
  ids: string[],
  ripple = false,
): TimelineState {
  return ids.length ? removeItemsWithGroups(state, ids, ripple) : state;
}
