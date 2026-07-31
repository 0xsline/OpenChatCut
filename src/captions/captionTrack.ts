import { captionsOnTrack, trackKind, type TimelineState, type TrackId } from '../editor/types';
import type { CaptionsData } from './types';
import { hasOperationalTranscript } from '../transcript/types';

/** Existing captions, or a default caption source derived from the selected track. */
export function captionsForTrack(state: TimelineState, trackId: TrackId): CaptionsData | null {
  if (trackKind(state, trackId) === 'caption') return captionsOnTrack(state, trackId);
  if (state.captions) return state.captions;
  const source = state.items.find((item) => item.track === trackId && hasOperationalTranscript(item));
  return source
    ? { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: source.id }
    : null;
}
