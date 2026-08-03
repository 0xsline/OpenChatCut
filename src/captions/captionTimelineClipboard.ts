import type { TimelineItem } from '../editor/types';
import {
  appendManualCue,
  appendManualLane,
  isManualCaptionEntry,
  newManualCaptions,
} from './manualCaptions';
import type { CaptionsData } from './types';

export interface CaptionTimelineCue {
  text: string;
  start: number;
  end: number;
}

export interface CaptionTimelineClipboard {
  kind: 'caption';
  cues: CaptionTimelineCue[];
}

function cleanCue(cue: CaptionTimelineCue): CaptionTimelineCue | null {
  const text = cue.text.trim();
  if (!text || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)) return null;
  const start = Math.max(0, Math.round(cue.start));
  return { text, start, end: Math.max(start + 1, Math.round(cue.end)) };
}

/** Snapshot selected cues as structured, timeline-relative content. */
export function createCaptionTimelineClipboard(cues: readonly CaptionTimelineCue[]): CaptionTimelineClipboard | null {
  const snapshot = cues
    .map(cleanCue)
    .filter((cue): cue is CaptionTimelineCue => cue !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  return snapshot.length ? { kind: 'caption', cues: snapshot } : null;
}

/** Place the first copied cue at the playhead while preserving subsequent gaps. */
export function createCaptionTrackFromClipboard(
  clipboard: CaptionTimelineClipboard | null,
  startAtMs: number,
): CaptionsData | null {
  if (!clipboard?.cues.length || !Number.isFinite(startAtMs)) return null;
  const base = clipboard.cues[0]!.start;
  let captions = newManualCaptions();
  const laneId = captions.sourceEntries?.[0]?.id;
  if (!laneId) return null;
  for (const cue of clipboard.cues) {
    const start = Math.max(0, Math.round(startAtMs + cue.start - base));
    const patch = appendManualCue(captions, laneId, cue.text, start, start + (cue.end - cue.start));
    if (!patch) return null;
    captions = { ...captions, ...patch };
  }
  return captions;
}

export function createTranslatedCaptionTrack(text: string, start: number, end: number): CaptionsData | null {
  return createCaptionTrackFromClipboard(createCaptionTimelineClipboard([{ text, start, end }]), start);
}

/** Paste structured cues into the current caption track when parent track creation is unavailable. */
export function appendCaptionClipboardToTrack(
  captions: CaptionsData,
  items: TimelineItem[],
  clipboard: CaptionTimelineClipboard | null,
  startAtMs: number,
): Partial<CaptionsData> | null {
  if (!clipboard?.cues.length || !Number.isFinite(startAtMs)) return null;
  let next = captions;
  let lane = next.sourceEntries?.find(isManualCaptionEntry);
  if (!lane) {
    next = { ...next, ...appendManualLane(next, items) };
    lane = next.sourceEntries?.find(isManualCaptionEntry);
  }
  if (!lane) return null;

  const base = clipboard.cues[0]!.start;
  for (const cue of clipboard.cues) {
    const start = Math.max(0, Math.round(startAtMs + cue.start - base));
    const patch = appendManualCue(next, lane.id, cue.text, start, start + cue.end - cue.start);
    if (!patch) return null;
    next = { ...next, ...patch };
  }
  return next;
}
