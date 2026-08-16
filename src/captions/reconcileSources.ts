import type { TimelineState } from '../editor/types.js';
import type { CaptionsData } from './types.js';

type CaptionMapper = (
  captions: CaptionsData | null | undefined,
) => CaptionsData | null | undefined;

function mapTimelineCaptions<State extends TimelineState>(state: State, map: CaptionMapper): State {
  const captions = map(state.captions);
  let tracks = state.tracks;
  if (state.tracks) {
    let changed = false;
    const nextTracks = { ...state.tracks };
    for (const [trackId, track] of Object.entries(state.tracks)) {
      if (!track?.captions) continue;
      const nextCaptions = map(track.captions);
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
  return mapTimelineCaptions(state, (captions) => reconcileCaptions(captions, liveItemIds));
}

function splitCaptions(
  captions: CaptionsData | null | undefined,
  originalId: string,
  rightId: string,
): CaptionsData | null | undefined {
  if (!captions || captions.sourceMode === 'timeline') return captions;
  let sources = captions.sources;
  if (sources?.includes(originalId)) {
    sources = sources.flatMap((id) => id === originalId ? [id, rightId] : [id]);
  } else if (captions.sourceItemId === originalId && !captions.sourceEntries?.length) {
    sources = [originalId, rightId];
  }
  let perSource = captions.perSource;
  let sourceEntries = captions.sourceEntries;
  if (sourceEntries?.some((entry) => entry.itemId === originalId && !entry.words)) {
    sourceEntries = sourceEntries.flatMap((entry) => {
      if (entry.itemId !== originalId || entry.words) return [entry];
      const splitId = `${entry.id}:split:${rightId}`;
      if (captions.perSource?.[entry.id]) {
        perSource = { ...perSource, [splitId]: { ...captions.perSource[entry.id] } };
      }
      return [entry, { ...entry, id: splitId, itemId: rightId }];
    });
  }
  if (sources === captions.sources && sourceEntries === captions.sourceEntries) return captions;
  return { ...captions, sources, sourceEntries, perSource };
}

/** Keep every caption source attached to both fragments of a split transcript item. */
export function remapSplitTimelineCaptionReferences<State extends TimelineState>(
  state: State,
  originalId: string,
  rightId: string,
): State {
  return mapTimelineCaptions(state, (captions) => splitCaptions(captions, originalId, rightId));
}
