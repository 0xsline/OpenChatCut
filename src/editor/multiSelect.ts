// Multi-select ops: move / remove a set of clips as one undoable step.
// Used by timeline pointer (group drag), shortcuts (⌫), and clip context menu.
import {
  selectedIdsOf, timelineTrackIds, trackKind,
  type TimelineItem, type TimelineState, type TrackId,
} from './types';

/** Ids that should move together when dragging `primaryId` (the grab handle). */
export function groupMoveIds(state: TimelineState, primaryId: string): string[] {
  const ids = selectedIdsOf(state);
  return ids.includes(primaryId) && ids.length > 1 ? ids : [primaryId];
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

  const idSet = new Set(ids);
  const items = state.items.map((it) => {
    if (!idSet.has(it.id)) return it;
    if (state.tracks?.[it.track]?.locked) return it;
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
    return { ...it, startFrame: Math.max(0, it.startFrame + deltaF), track };
  });
  return { ...state, items };
}

/** Remove many clips; optional ripple close-gap per clip (reverse chrono so indices stay valid). */
export function removeItemsFromState(
  state: TimelineState,
  ids: string[],
  ripple = false,
): TimelineState {
  if (!ids.length) return state;
  let items = [...state.items];
  let transitions = [...(state.transitions ?? [])];
  const sorted = [...ids]
    .map((id) => items.find((x) => x.id === id))
    .filter((x): x is TimelineItem => !!x)
    .sort((a, b) => b.startFrame - a.startFrame);
  for (const gone of sorted) {
    if (state.tracks?.[gone.track]?.locked) continue;
    const end = gone.startFrame + gone.durationInFrames;
    items = items
      .filter((it) => it.id !== gone.id)
      .map((it) => (ripple && it.track === gone.track && it.startFrame >= end
        ? { ...it, startFrame: Math.max(0, it.startFrame - gone.durationInFrames) }
        : it));
    transitions = transitions.filter((t) => t.incomingItemId !== gone.id && t.outgoingItemId !== gone.id);
  }
  return {
    ...state,
    items,
    transitions,
    selectedId: null,
    selectedIds: [],
  };
}
