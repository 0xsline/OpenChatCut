import type { TimelineState } from '../editor/types.js';
import type { CaptionsData } from './types.js';

function reconcileCaptions(
  captions: CaptionsData | null | undefined,
  liveItemIds: ReadonlySet<string>,
): CaptionsData | null | undefined {
  if (!captions) return captions;
  let next = captions;

  if (next.sourceItemId && !liveItemIds.has(next.sourceItemId)) {
    next = { ...next, sourceItemId: undefined };
  }

  if (Array.isArray(next.sources)) {
    const sources = next.sources.filter((id) => liveItemIds.has(id));
    if (sources.length !== next.sources.length) {
      next = { ...next, sources: sources.length ? sources : undefined };
    }
  }

  if (Array.isArray(next.sourceEntries)) {
    const sourceEntries = next.sourceEntries.filter((entry) =>
      entry.itemId.startsWith('manual:') || liveItemIds.has(entry.itemId));
    if (sourceEntries.length !== next.sourceEntries.length) {
      next = { ...next, sourceEntries: sourceEntries.length ? sourceEntries : undefined };
    }
  }

  return next;
}

/** Remove only caption source bindings that no longer point at timeline items. */
export function reconcileTimelineCaptionReferences<State extends TimelineState>(state: State): State {
  const liveItemIds = new Set(state.items.map((item) => item.id));
  const captions = reconcileCaptions(state.captions, liveItemIds);
  let tracks = state.tracks;

  if (state.tracks) {
    let changed = false;
    const nextTracks = { ...state.tracks };
    for (const [trackId, track] of Object.entries(state.tracks)) {
      if (!track?.captions) continue;
      const nextCaptions = reconcileCaptions(track.captions, liveItemIds);
      if (nextCaptions === track.captions) continue;
      nextTracks[trackId] = { ...track, captions: nextCaptions };
      changed = true;
    }
    if (changed) tracks = nextTracks;
  }

  return captions === state.captions && tracks === state.tracks
    ? state
    : { ...state, captions, tracks } as State;
}
