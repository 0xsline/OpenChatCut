// Shapes shared by the FCPXML and EDL timeline importers.

export type ClipFamily = 'video' | 'audio';

/** Where a clip came from, for reports: element kind, name, and the NLE timecode it starts at. */
export interface ClipSource {
  element: string;
  name: string;
  at: string;
}

export function describeSource(source: ClipSource): string {
  return `${source.element} "${source.name}" at ${source.at}`;
}

/** One clip placed on the imported timeline, already converted to timeline frames. */
export interface ParsedClip {
  name: string;
  assetId: string;
  family: ClipFamily;
  /**
   * Interchange lane, used only to order and separate tracks within a family:
   * a higher lane is placed above a lower one (FCPXML lanes; EDL V = 1, A1 = -1).
   */
  lane: number;
  startFrame: number;
  durationInFrames: number;
  sourceStartFrame: number;
  playbackRate?: number;
  /** The source disabled this clip's own audio (FCPXML srcEnable="video"). */
  muted?: boolean;
  /** Audio component/event read from a video file: OCC plays it from the video clip. */
  audioOfVideo?: boolean;
  from: ClipSource;
}

export interface SkippedElement {
  element: string;
  name?: string;
  /** Sequence-relative position when known (timecode label on the imported timeline). */
  at?: string;
  reason: string;
}

export interface ImportReport {
  warnings: string[];
  skipped: SkippedElement[];
}

export interface ParsedTimeline {
  name: string;
  fps: number;
  width: number;
  height: number;
  clips: ParsedClip[];
  warnings: string[];
  skipped: SkippedElement[];
  /** Source timecode that became frame 0 (FCPXML sequence tcStart / EDL record start). */
  startTimecode?: string;
}

export interface UnresolvedReference {
  reference: string;
  reason: string;
}

export type ParseResult = { ok: true; timeline: ParsedTimeline } | {
  ok: false;
  error: string;
  unresolved?: UnresolvedReference[];
  skipped?: SkippedElement[];
};

export interface TimelineImportOptions {
  /** EDL only: frame rate the list was written at (CMX 3600 does not record it). */
  fps?: number;
  /** EDL only: record timecode that becomes frame 0 of the imported timeline. */
  startTimecode?: string;
}

export function newReport(): ImportReport {
  return { warnings: [], skipped: [] };
}
