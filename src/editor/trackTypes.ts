import type { CaptionsData } from '../captions/types.js';

/** Stable track id. Human aliases (C1/V1/A1/...) are derived from track order. */
export type TrackId = string;
export type TrackKind = 'video' | 'audio' | 'caption';
export type TrackRole = 'anchor' | 'follower';
export const TRACK_ORDER: TrackId[] = ['V2', 'V1', 'A1', 'A2'];

/** per-track state (edit_track). The map key is the stable track id. */
export interface TrackFlags {
  kind?: TrackKind;
  name?: string;
  /** Caption payload owned by this caption track. */
  captions?: CaptionsData | null;
  /** hidden track is fully disabled — its items render neither picture nor sound */
  hidden?: boolean;
  /** muted track keeps its picture but produces no audio */
  muted?: boolean;
  /** local editor controls: lock structural edits / collapse the lane
   * (collapsed = track-header collapse chevron → thin strip) */
  locked?: boolean;
  collapsed?: boolean;
  /** anchor speech triggers ducking; follower music ducks under anchors */
  role?: TrackRole;
  audioRouting?: { duckDepthDb?: number };
}

export type TrackUpdate = Partial<Omit<TrackFlags, 'kind' | 'role' | 'audioRouting' | 'captions'>> & {
  order?: number;
  role?: TrackRole | null;
  audioRouting?: { duckDepthDb?: number | null };
};
