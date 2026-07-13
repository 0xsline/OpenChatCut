// Timeline domain model. Deliberately small; mirrors the shape ChatCut's
// agent tools operate on (items with frame positions on named tracks).

export type TrackId = 'V2' | 'V1' | 'A1' | 'A2';
export const TRACK_ORDER: TrackId[] = ['V2', 'V1', 'A1', 'A2'];

export interface TimelineItem {
  id: string;
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
  kind: 'motion-graphic';
  templateId: string;
  name: string;
  code: string;
  props: Record<string, unknown>;
  /** natural box size the template designs against */
  width: number;
  height: number;
}

export interface TimelineState {
  fps: number;
  width: number;
  height: number;
  items: TimelineItem[];
  selectedId: string | null;
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
