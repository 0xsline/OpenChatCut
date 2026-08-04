/** Timeline chrome and default row geometry shared outside React components. */
export const TIMELINE_TOOLBAR_HEIGHT = 36;
export const TIMELINE_RULER_HEIGHT = 28;
export const TIMELINE_DEFAULT_TRACK_HEIGHT = 56;
export const TIMELINE_MIN_VISIBLE_TRACKS = 4;
export const TIMELINE_MAX_VISIBLE_TRACKS = 6;

export function timelineHeightForVisibleTracks(trackCount: number): number {
  const visibleTrackCount = Math.min(
    TIMELINE_MAX_VISIBLE_TRACKS,
    Math.max(TIMELINE_MIN_VISIBLE_TRACKS, Math.floor(trackCount)),
  );
  return TIMELINE_TOOLBAR_HEIGHT
    + TIMELINE_RULER_HEIGHT
    + TIMELINE_DEFAULT_TRACK_HEIGHT * visibleTrackCount;
}

export const TIMELINE_MIN_HEIGHT = timelineHeightForVisibleTracks(TIMELINE_MIN_VISIBLE_TRACKS);
export const TIMELINE_MAX_HEIGHT = timelineHeightForVisibleTracks(TIMELINE_MAX_VISIBLE_TRACKS);
