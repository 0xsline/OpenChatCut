import type { Action } from '../../editor/reduce';
import {
  captionsOnTrack,
  timelineTrackIds,
  trackKind,
  type TimelineState,
  type TrackId,
} from '../../editor/types';

export interface TrackDeletePlan {
  blockedReason: 'missing' | 'last-video' | 'locked' | null;
  hasContents: boolean;
  requiresConfirmation: boolean;
  actions: Action[];
}

/** Build one explicit, undoable cascade for the visible track-delete command. */
export function trackDeletePlan(state: TimelineState, trackId: TrackId): TrackDeletePlan {
  const trackIds = timelineTrackIds(state);
  if (!trackIds.includes(trackId)) {
    return { blockedReason: 'missing', hasContents: false, requiresConfirmation: false, actions: [] };
  }
  if (trackKind(state, trackId) === 'video'
    && trackIds.filter((id) => trackKind(state, id) === 'video').length === 1) {
    return { blockedReason: 'last-video', hasContents: false, requiresConfirmation: false, actions: [] };
  }
  if (state.tracks?.[trackId]?.locked) {
    return { blockedReason: 'locked', hasContents: false, requiresConfirmation: false, actions: [] };
  }

  const itemIds = new Set(state.items.filter((item) => item.track === trackId).map((item) => item.id));
  const transitionIds = (state.transitions ?? [])
    .filter((transition) => transition.trackId === trackId
      || itemIds.has(transition.incomingItemId)
      || itemIds.has(transition.outgoingItemId))
    .map((transition) => transition.id);
  const ownsCaptions = !!captionsOnTrack(state, trackId);
  const hasContents = itemIds.size > 0 || transitionIds.length > 0 || ownsCaptions;
  const actions: Action[] = [
    ...transitionIds.map((id): Action => ({ type: 'removeTransition', id })),
    ...[...itemIds].map((id): Action => ({ type: 'remove', id })),
    ...(ownsCaptions ? [{ type: 'setCaptions', captions: null, track: trackId } as Action] : []),
    { type: 'track.delete', tracks: [trackId] },
  ];
  return { blockedReason: null, hasContents, requiresConfirmation: hasContents, actions };
}
