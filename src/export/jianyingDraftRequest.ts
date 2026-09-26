// The timeline half of a JianYing / CapCut draft export request. The export
// dialog POSTs it to /api/external-agent/jianying-export, the agent tool does the
// same (or hands it to exportJianyingDraft in-process on a headless host), so both
// build it here and the exporter always receives the same clips.
//
// Every clip carries the source window the preview actually plays — srcInFrame
// and playbackRate, read the way MediaFill / AudioClip read them — so the exporter
// can trim its draft segment instead of starting every clip at source 0.
import { activeTimeline, type ProjectDoc, type TimelineItem, type TimelineState } from '../editor/types';
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

function draftClip(item: TimelineItem & { kind: JianyingDraftClipKind }, span: PlaybackSpan): JianyingDraftClip {
  return {
    kind: item.kind,
    src: item.src ?? '',
    startFrame: span.startFrame,
    durationInFrames: span.endFrame - span.startFrame,
    srcInFrame: span.srcInFrame,
    playbackRate: span.playbackRate,
    volume: item.volume,
    name: item.name,
  };
}

/** Caption cues from the active captions overlay: merge transcript words into
 * phrase cues (timeline ms). Falls back to the source item's transcript. */
export function captionCues(state: { fps: number; items: TimelineItem[] }, captions: { enabled?: boolean; sourceItemId?: string | null; sourceMode?: 'item' | 'timeline'; sources?: string[] } | null | undefined): JianyingDraftCaption[] {
  if (!captions?.enabled) return [];
  const cueWords = (item: TimelineItem | undefined): { start: number; end: number; text: string }[] | undefined => {
    if (!item?.transcript || item.transcript.length === 0) return undefined;
    return item.transcript;
  };
  let words: { start: number; end: number; text: string }[] = [];
  if (captions.sourceMode === 'timeline') {
    for (const item of state.items) {
      const candidate = cueWords(item);
      if (candidate) words = [...words, ...candidate];
    }
  } else if (captions.sourceItemId) {
    words = cueWords(state.items.find((item) => item.id === captions.sourceItemId)) ?? [];
  }
  if (words.length === 0) return [];
  words = [...words].sort((a, b) => a.start - b.start);
  const cues: JianyingDraftCaption[] = [];
  let current: JianyingDraftCaption | null = null;
  for (const word of words) {
    if (!word.text.trim()) continue;
    if (!current) {
      current = { startMs: word.start, endMs: word.end, text: word.text.trim() };
      continue;
    }
    const gap = word.start - current.endMs;
    if (gap <= 450) {
      current.endMs = Math.max(current.endMs, word.end);
      current.text = `${current.text} ${word.text.trim()}`;
    } else {
      cues.push(current);
      current = { startMs: word.start, endMs: word.end, text: word.text.trim() };
    }
  }
  if (current) cues.push(current);
  return cues;
}

function timelineClips(timeline: TimelineState): JianyingDraftClip[] {
  return timeline.items
    .filter(isDraftClipItem)
    .flatMap((item) => playbackSpans(item, timeline.fps).map((span) => draftClip(item, span)));
}

/** The clips and captions of the project's active timeline, as the exporter takes them. */
export function jianyingDraftPayload(project: ProjectDoc): JianyingDraftPayload {
  const timeline = activeTimeline(project);
  return {
    fps: timeline.fps,
    items: timelineClips(timeline),
    captions: captionCues(timeline, timeline.captions),
  };
}
