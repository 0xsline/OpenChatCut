// Timeline domain model. Deliberately small; mirrors the shape ChatCut's
// agent tools operate on (items with frame positions on named tracks).

import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';

export type TrackId = 'V2' | 'V1' | 'A1' | 'A2';
export const TRACK_ORDER: TrackId[] = ['V2', 'V1', 'A1', 'A2'];

/** An imported media file in the project's media pool (source: S3 asset). */
export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  src: string; // same-origin path under /media/uploads
  durationInFrames: number;
  width?: number;
  height?: number;
}

export interface TimelineItem {
  id: string;
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
  name: string;
  kind: 'motion-graphic' | 'audio' | 'video' | 'image';
  // motion-graphic fields:
  templateId?: string;
  code?: string;
  props?: Record<string, unknown>;
  /** natural box size the template designs against */
  width?: number;
  height?: number;
  // audio / video / image source:
  src?: string;
  /** 0..1 playback volume (default 1) — audio + video */
  volume?: number;
  /** source in-point (frames) for video/audio trimming — left-trim advances it */
  srcInFrame?: number;
  /** transcript-based editing: the clip's words + which are deleted (by index).
   * durationInFrames reflects the EDITED length (kept words only). */
  transcript?: TranscriptWord[];
  deletedWordIdx?: number[];
  /** clean_script silence compression: cap inter-word pauses to this many frames
   * (undefined = keep every pause at its recorded length). */
  silenceFrames?: number;
}

/** how 16:9-designed content adapts when the canvas ratio changes (source `fit`) */
export type AspectFit = 'contain' | 'cover';

export interface AspectPreset {
  label: string;
  width: number;
  height: number;
}

/** canvas ratios for long-to-short retargeting (source manage_timelines `ratio`) */
export const ASPECT_PRESETS: AspectPreset[] = [
  { label: '16:9', width: 1920, height: 1080 },
  { label: '9:16', width: 1080, height: 1920 },
  { label: '1:1', width: 1080, height: 1080 },
  { label: '4:3', width: 1440, height: 1080 },
  { label: '3:4', width: 1080, height: 1440 },
];

/** per-track visibility/audio flags (source edit_track: visible / mute) */
export interface TrackFlags {
  /** hidden track is fully disabled — its items render neither picture nor sound */
  hidden?: boolean;
  /** muted track keeps its picture but produces no audio */
  muted?: boolean;
}

export interface TimelineState {
  fps: number;
  width: number;
  height: number;
  /** how items fit when the canvas ratio differs from their design box */
  fit?: AspectFit;
  items: TimelineItem[];
  /** per-track hide/mute (keyed by TrackId; absent = both false) */
  tracks?: Partial<Record<TrackId, TrackFlags>>;
  /** imported media pool ("我的素材") */
  assets?: MediaAsset[];
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
