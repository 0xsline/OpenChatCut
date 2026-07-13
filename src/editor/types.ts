// Timeline domain model. Deliberately small; mirrors the shape ChatCut's
// agent tools operate on (items with frame positions on named tracks).

import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';

export type TrackId = 'V2' | 'V1' | 'A1' | 'A2';
export const TRACK_ORDER: TrackId[] = ['V2', 'V1', 'A1', 'A2'];

export interface TimelineItem {
  id: string;
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
  name: string;
  kind: 'motion-graphic' | 'audio';
  // motion-graphic fields:
  templateId?: string;
  code?: string;
  props?: Record<string, unknown>;
  /** natural box size the template designs against */
  width?: number;
  height?: number;
  // audio fields:
  src?: string;
  /** 0..1 playback volume (default 1) */
  volume?: number;
  /** transcript-based editing: the clip's words + which are deleted (by index).
   * durationInFrames reflects the EDITED length (kept words only). */
  transcript?: TranscriptWord[];
  deletedWordIdx?: number[];
}

export interface TimelineState {
  fps: number;
  width: number;
  height: number;
  items: TimelineItem[];
  selectedId: string | null;
  /** captions overlay (字幕), rendered on top + burned into export */
  captions?: CaptionsData | null;
}

/** total timeline length = last item's end (min 1s). */
export function timelineDuration(s: TimelineState): number {
  const end = s.items.reduce((m, it) => Math.max(m, it.startFrame + it.durationInFrames), 0);
  return Math.max(end, s.fps);
}

/** first free frame on a track (append point). */
export function trackEnd(s: TimelineState, track: TrackId): number {
  return s.items
    .filter((it) => it.track === track)
    .reduce((m, it) => Math.max(m, it.startFrame + it.durationInFrames), 0);
}
