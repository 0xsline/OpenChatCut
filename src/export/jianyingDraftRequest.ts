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
import {
  activeTimeline, captionOverlayVisible, captionTrackEntries, timelineTrackIds, trackAlias,
  type AspectFit, type ProjectDoc, type TimelineItem, type TrackId,
} from '../editor/types';
import { previewTextEditFields } from '../components/preview/previewTextEdit';
import { placeRange, timelinePlacements, type TimelinePlacement } from '../editor/sequenceFlatten';
import { sourceFrameAt, timelineFramesToSourceFrames } from '../editor/sourceLimit';
import { transcriptSegments } from './fcpxml';

export type JianyingDraftClipKind = 'video' | 'image' | 'gif' | 'audio' | 'graphic';

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
  trackName?: string;
  layer?: number;
  graphic?: { item: TimelineItem; width: number; height: number; fit?: AspectFit };
}

export interface JianyingDraftCaption {
  startMs: number;
  endMs: number;
  text: string;
  trackName?: string;
}

export interface JianyingDraftPayload {
  fps: number;
  width: number;
  height: number;
  items: JianyingDraftClip[];
  captions: JianyingDraftCaption[];
}

type FileClipKind = Exclude<JianyingDraftClipKind, 'graphic'>;
const DRAFT_CLIP_KINDS: ReadonlySet<string> = new Set<FileClipKind>(['video', 'image', 'gif', 'audio']);

function isDraftClipItem(item: TimelineItem): item is TimelineItem & { kind: FileClipKind } {
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
function playbackSpans(item: TimelineItem & { kind: FileClipKind }, fps: number): PlaybackSpan[] {
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
type ExportLane = { trackName: string; layer: number };

function laneOrder(placement: TimelinePlacement, track: TrackId): number[] {
  return [...(placement.ancestorTracks ?? []), { timeline: placement.timeline, track }]
    .map(({ timeline, track }) => timelineTrackIds(timeline).reverse().indexOf(track));
}

function compareLaneOrder(a: number[], b: number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function placedClips(placement: TimelinePlacement, lanes: Map<TrackId, ExportLane>): JianyingDraftClip[] {
  const { timeline } = placement;
  const ancestorMuted = placement.ancestorTracks?.some(({ timeline, track }) => timeline.tracks?.[track]?.muted);
  return timeline.items.filter(isDraftClipItem).filter((item) => lanes.has(item.track))
    .flatMap((item) => playbackSpans(item, timeline.fps).flatMap((span) => {
    const placed = placeRange(placement, span.startFrame, span.endFrame);
    if (!placed) return [];
    const still = item.kind === 'image' || item.kind === 'gif';
    return [{
      kind: item.kind,
      src: item.kind === 'audio' ? item.denoisedSrc ?? item.src ?? '' : item.src ?? '',
      startFrame: placed.rootStart,
      durationInFrames: placed.rootDuration,
      srcInFrame: still ? 0 : sourceFrameAt(span, placed.localStart - span.startFrame),
      playbackRate: still ? 1 : span.playbackRate * placement.rate,
      volume: ancestorMuted || timeline.tracks?.[item.track]?.muted ? 0 : item.volume,
      name: item.name,
      ...lanes.get(item.track),
    }];
  }));
}

/** Some caption templates store their cue pages as a JSON string in MG props. */
function graphicCaptionPages(item: TimelineItem): JianyingDraftCaption[] {
  let pages: unknown = item.props?.pages;
  if (typeof pages === 'string') {
    try { pages = JSON.parse(pages) as unknown; } catch { return []; }
  }
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page) => {
    if (!page || typeof page !== 'object' || typeof page.text !== 'string' ||
      typeof page.start !== 'number' || typeof page.end !== 'number' ||
      !Number.isFinite(page.start) || !Number.isFinite(page.end) || page.end <= page.start) return [];
    return [{ startMs: page.start, endMs: page.end, text: page.text }];
  });
}

// A nested timeline's captions render inside its sequence (NestedSequenceLayer
// draws the child's own caption layer), so they are clipped to the sequence
// window and re-timed onto the root like its clips. Cues are timed in ms, so
// the placement is converted rather than round-tripping ms through frames; the
// graph check rejects fps mismatches, so one fps serves child and root frames.
function placedCaptions(placement: TimelinePlacement, lanes: Map<TrackId, ExportLane>, index: number): JianyingDraftCaption[] {
  const { timeline } = placement;
  const ms = (frames: number) => (frames * 1000) / placement.timeline.fps;
  const inMs: TimelinePlacement = {
    ...placement,
    fromFrame: ms(placement.fromFrame),
    toFrame: ms(placement.toFrame),
    rootFrame: ms(placement.rootFrame),
  };
  const entries = captionTrackEntries(timeline).filter(({ id }) => lanes.has(id));
  const cues = entries.flatMap(({ id, captions }) => captions?.enabled
    ? captionPages(captions, timeline.items, timeline.fps)
      .map((page) => ({ startMs: page.start, endMs: page.end, text: joinCaptionWords(page.words), trackName: lanes.get(id)?.trackName }))
    : []);
  const legacy = timeline.captions;
  if (legacy?.enabled && !captionTrackEntries(timeline).some(({ captions }) => captions === legacy)) {
    cues.push(...captionPages(legacy, timeline.items, timeline.fps)
      .map((page) => ({ startMs: page.start, endMs: page.end, text: joinCaptionWords(page.words), trackName: `字幕 ${index + 1}` })));
  }
  for (const item of timeline.items) {
    const lane = lanes.get(item.track);
    if (!lane) continue;
    const start = ms(item.startFrame);
    const end = ms(item.startFrame + item.durationInFrames);
    if (item.kind === 'text' && typeof item.props?.text === 'string' && item.props.text.trim()) {
      cues.push({ startMs: start, endMs: end, text: item.props.text, trackName: lane.trackName });
    }
    if (item.kind !== 'motion-graphic') continue;
    for (const cue of graphicCaptionPages(item)) {
      const startMs = Math.max(start, start + cue.startMs);
      const endMs = Math.min(end, start + cue.endMs);
      if (endMs > startMs) cues.push({ startMs, endMs, text: cue.text, trackName: lane.trackName });
    }
  }
  return cues.flatMap((cue) => {
    const placed = placeRange(inMs, cue.startMs, cue.endMs);
    return placed ? [{ ...cue, startMs: placed.rootStart, endMs: placed.rootStart + placed.rootDuration }] : [];
  });
}

function placedGraphics(placement: TimelinePlacement, lanes: Map<TrackId, ExportLane>): JianyingDraftClip[] {
  const { timeline } = placement;
  return timeline.items.flatMap((item) => {
    if (item.kind !== 'solid' && item.kind !== 'motion-graphic') return [];
    const lane = lanes.get(item.track);
    if (!lane || (!captionOverlayVisible(timeline) && previewTextEditFields(item)) || graphicCaptionPages(item).length) return [];
    const placed = placeRange(placement, item.startFrame, item.startFrame + item.durationInFrames);
    if (!placed) return [];
    return [{
      kind: 'graphic',
      src: '',
      startFrame: placed.rootStart,
      durationInFrames: placed.rootDuration,
      srcInFrame: placed.localStart - item.startFrame,
      playbackRate: placement.rate,
      name: item.name,
      graphic: { item, width: timeline.width, height: timeline.height, fit: timeline.fit },
      ...lane,
    }];
  });
}

/** The clips and captions of the project's active timeline, as the exporter
 * takes them, with nested sequences flattened onto it in timeline order. */
export function jianyingDraftPayload(project: ProjectDoc): JianyingDraftPayload {
  const timeline = activeTimeline(project);
  const placements = timelinePlacements(project, timeline.id).filter((placement) =>
    !placement.ancestorTracks?.some(({ timeline, track }) => timeline.tracks?.[track]?.hidden));
  const lanes = new Map(placements.map((placement) => [placement, new Map<TrackId, ExportLane>()]));
  const ordered = placements.flatMap((placement) => timelineTrackIds(placement.timeline)
    .filter((track) => !placement.timeline.tracks?.[track]?.hidden)
    .map((track) => ({ placement, track, order: laneOrder(placement, track) })))
    .sort((a, b) => compareLaneOrder(a.order, b.order));
  const labels = new Set<string>();
  ordered.forEach(({ placement, track }, layer) => {
    const alias = trackAlias(placement.timeline, track);
    const label = [alias, placement.timeline.tracks?.[track]?.name].filter(Boolean).join(' ');
    let trackName = label;
    for (let suffix = 2; labels.has(trackName); suffix++) trackName = `${label} (${suffix})`;
    labels.add(trackName);
    lanes.get(placement)?.set(track, { trackName, layer });
  });
  return {
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    items: placements.flatMap((placement) => {
      const tracks = lanes.get(placement)!;
      return [...placedClips(placement, tracks), ...placedGraphics(placement, tracks)];
    }).sort((a, b) => a.startFrame - b.startFrame),
    captions: placements.flatMap((placement, index) => placement.timeline.captionsHidden !== true &&
        (captionOverlayVisible(placement.timeline) || placement.timeline.captions?.enabled)
      ? placedCaptions(placement, lanes.get(placement)!, index)
      : []).sort((a, b) => a.startMs - b.startMs),
  };
}
