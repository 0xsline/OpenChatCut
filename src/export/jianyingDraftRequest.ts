// The timeline half of a JianYing / CapCut draft export request. The export
// dialog POSTs it to /api/external-agent/jianying-export, the agent tool does the
// same (or hands it to exportJianyingDraft in-process on a headless host), so both
// build it here and the exporter always receives the same clips.
//
// Every clip carries the source window the preview actually plays — srcInFrame
// and playbackRate, read the way MediaFill / AudioClip read them — so the exporter
// can trim its draft segment instead of starting every clip at source 0. A draft
// cannot nest, so sequence items are flattened into the clips and captions they
// show (sequenceFlatten).
import { captionPages } from '../captions/exportCaptions';
import { joinCaptionWords } from '../captions/types';
import { activeTimeline, type ProjectDoc, type TimelineItem, type TimelineState } from '../editor/types';
import { placeRange, timelinePlacements, type TimelinePlacement } from '../editor/sequenceFlatten';
import { sourceFrameAt, timelineFramesToSourceFrames } from '../editor/sourceLimit';
import { transcriptSegments } from './fcpxml';

export type JianyingDraftClipKind = 'video' | 'image' | 'gif' | 'audio';

export interface JianyingDraftClip {
  kind: JianyingDraftClipKind;
  src: string;
  /** Timeline position and length, in frames at the request fps. */
  startFrame: number;
  durationInFrames: number;
  /** Source frame the clip starts reading its media at (0 for stills). */
  srcInFrame: number;
  /** Source frames consumed per timeline frame (1 for stills). */
  playbackRate: number;
  volume?: number;
  name: string;
}

export interface JianyingDraftCaption {
  startMs: number;
  endMs: number;
  text: string;
}

export interface JianyingDraftPayload {
  fps: number;
  items: JianyingDraftClip[];
  captions: JianyingDraftCaption[];
}

const DRAFT_CLIP_KINDS: ReadonlySet<string> = new Set<JianyingDraftClipKind>(['video', 'image', 'gif', 'audio']);

function isDraftClipItem(item: TimelineItem): item is TimelineItem & { kind: JianyingDraftClipKind } {
  return DRAFT_CLIP_KINDS.has(item.kind);
}

/** One contiguous source span a media item plays, in its timeline's frames. */
interface PlaybackSpan {
  startFrame: number;
  endFrame: number;
  srcInFrame: number;
  playbackRate: number;
}

// Stills render through <Img> and ignore trim and speed. Word-driven audio plays
// only its kept word runs (srcInFrame is a window over that edited stream, not a
// media frame), so it exports one clip per run — the FCPXML export's split.
function playbackSpans(item: TimelineItem & { kind: JianyingDraftClipKind }, fps: number): PlaybackSpan[] {
  const endFrame = item.startFrame + item.durationInFrames;
  if (item.kind === 'image' || item.kind === 'gif') {
    return [{ startFrame: item.startFrame, endFrame, srcInFrame: 0, playbackRate: 1 }];
  }
  const kept = transcriptSegments(item, fps);
  if (kept) {
    return kept.map((segment) => ({
      startFrame: segment.fromFrame,
      endFrame: segment.fromFrame + segment.durFrames,
      srcInFrame: segment.srcStartFrame,
      playbackRate: 1,
    }));
  }
  return [{
    startFrame: item.startFrame,
    endFrame,
    srcInFrame: sourceFrameAt(item, 0),
    playbackRate: timelineFramesToSourceFrames(item, 1),
  }];
}

// A span clipped by its sequence window starts that many frames later in its
// source; rates compose through the nesting. Stills stay stills.
function placedClips(placement: TimelinePlacement): JianyingDraftClip[] {
  const { timeline } = placement;
  return timeline.items.filter(isDraftClipItem).flatMap((item) => playbackSpans(item, timeline.fps).flatMap((span) => {
    const placed = placeRange(placement, span.startFrame, span.endFrame);
    if (!placed) return [];
    const still = item.kind === 'image' || item.kind === 'gif';
    return [{
      kind: item.kind,
      src: item.src ?? '',
      startFrame: placed.rootStart,
      durationInFrames: placed.rootDuration,
      srcInFrame: still ? 0 : sourceFrameAt(span, placed.localStart - span.startFrame),
      playbackRate: still ? 1 : span.playbackRate * placement.rate,
      volume: item.volume,
      name: item.name,
    }];
  }));
}

/** A timeline's caption cues, in its own ms: the pages of its default caption
 * track exactly as the preview shows them and the subtitle (.srt) export writes
 * them — words projected through their clip's position, in-point, speed and
 * transcript edits, so they stay on the trimmed clips the draft now holds. */
function timelineCaptionCues(timeline: TimelineState): JianyingDraftCaption[] {
  const captions = timeline.captions;
  if (!captions?.enabled) return [];
  return captionPages(captions, timeline.items, timeline.fps)
    .map((page) => ({ startMs: page.start, endMs: page.end, text: joinCaptionWords(page.words) }));
}

// A nested timeline's captions render inside its sequence (NestedSequenceLayer
// draws the child's own caption layer), so they are clipped to the sequence
// window and re-timed onto the root like its clips. Cues are timed in ms, so
// the placement is converted rather than round-tripping ms through frames; the
// graph check rejects fps mismatches, so one fps serves child and root frames.
function placedCaptions(placement: TimelinePlacement): JianyingDraftCaption[] {
  const ms = (frames: number) => (frames * 1000) / placement.timeline.fps;
  const inMs: TimelinePlacement = {
    ...placement,
    fromFrame: ms(placement.fromFrame),
    toFrame: ms(placement.toFrame),
    rootFrame: ms(placement.rootFrame),
  };
  return timelineCaptionCues(placement.timeline).flatMap((cue) => {
    const placed = placeRange(inMs, cue.startMs, cue.endMs);
    return placed ? [{ startMs: placed.rootStart, endMs: placed.rootStart + placed.rootDuration, text: cue.text }] : [];
  });
}

/** The clips and captions of the project's active timeline, as the exporter
 * takes them, with nested sequences flattened onto it in timeline order. */
export function jianyingDraftPayload(project: ProjectDoc): JianyingDraftPayload {
  const timeline = activeTimeline(project);
  const placements = timelinePlacements(project, timeline.id);
  return {
    fps: timeline.fps,
    items: placements.flatMap(placedClips).sort((a, b) => a.startFrame - b.startFrame),
    captions: placements.flatMap(placedCaptions).sort((a, b) => a.startMs - b.startMs),
  };
}
