// Builds a parsed interchange timeline in an editor draft: one track per planned
// lane, every clip at its exact frames, then a check that nothing moved.
import type { DraftEngine } from '../../editor/store';
import type { ProjectDoc, TimelineItem, TrackId } from '../../editor/types';
import { planTracks, type PlannedTrack } from './timeline-import-layout';
import { describeSource, type ImportReport, type ParsedClip, type ParsedTimeline } from './timeline-import-types';

export interface BuiltTimeline {
  doc: ProjectDoc;
  timelineId: string;
  trackCount: number;
  itemCount: number;
}

/** Track ids in the planned visual order. The new timeline's own video track becomes the lowest video track. */
function createTracks(draft: DraftEngine, planned: readonly PlannedTrack[]): TrackId[] {
  const initial = draft.getState().trackOrder?.[0];
  const ids: Array<TrackId | undefined> = planned.map(() => undefined);
  // A new video track is inserted above the existing ones, so create them bottom-up.
  const videoIndexes = planned.map((track, index) => (track.family === 'video' ? index : -1)).filter((index) => index >= 0);
  for (const index of videoIndexes.toReversed()) {
    const name = planned[index]!.name;
    if (index === videoIndexes.at(-1) && initial) {
      draft.commands.updateTrack(initial, { name });
      ids[index] = initial;
    } else {
      ids[index] = draft.commands.createTrack('video', { name });
    }
  }
  // A new audio track is appended below the existing ones.
  planned.forEach((track, index) => {
    if (track.family === 'audio') ids[index] = draft.commands.createTrack('audio', { name: track.name });
  });
  return ids as TrackId[];
}

function itemPatch(clip: ParsedClip): Partial<TimelineItem> | null {
  const patch: Partial<TimelineItem> = {
    ...(clip.playbackRate !== undefined ? { playbackRate: clip.playbackRate } : {}),
    ...(clip.muted ? { volume: 0 } : {}),
  };
  return Object.keys(patch).length ? patch : null;
}

export function buildImportedTimeline(
  draft: DraftEngine,
  timeline: ParsedTimeline,
  name: string,
  report: ImportReport,
): BuiltTimeline {
  // A new sequence runs at the project rate, which the parsers counted the clips in.
  const timelineId = draft.commands.createTimeline({
    name,
    width: timeline.width,
    height: timeline.height,
    activate: true,
  });
  const planned = planTracks(timeline.clips, report);
  const trackIds = createTracks(draft, planned);
  const placed = new Map<string, { clip: ParsedClip; track: TrackId }>();
  const patches = new Map<string, Partial<TimelineItem>>();
  planned.forEach((track, index) => {
    for (const clip of track.clips) {
      const asset = draft.getDoc().assets.find((candidate) => candidate.id === clip.assetId)!;
      const itemId = draft.commands.addMediaItem({ ...asset, durationInFrames: clip.durationInFrames }, {
        track: trackIds[index],
        startFrame: clip.startFrame,
        srcInFrame: clip.sourceStartFrame,
      });
      placed.set(itemId, { clip, track: trackIds[index]! });
      const patch = itemPatch(clip);
      if (patch) patches.set(itemId, patch);
    }
  });
  const current = draft.getDoc();
  const doc: ProjectDoc = {
    ...current,
    timelines: current.timelines.map((item) => (item.id === timelineId
      ? {
        ...item,
        items: item.items.map((clip) => (patches.has(clip.id) ? { ...clip, ...patches.get(clip.id) } : clip)),
      }
      : item)),
  };
  // The layout never overlaps clips on a track, so the editor has no reason to
  // move one; report it instead of trusting that silently.
  const items = new Map(doc.timelines.find((item) => item.id === timelineId)!.items.map((item) => [item.id, item]));
  let itemCount = 0;
  for (const [itemId, { clip, track }] of placed) {
    const item = items.get(itemId);
    if (item && item.track === track && item.startFrame === clip.startFrame && item.durationInFrames === clip.durationInFrames) {
      itemCount += 1;
    } else {
      report.skipped.push({
        element: clip.from.element,
        name: clip.from.name,
        at: clip.from.at,
        reason: item ? `the editor moved it to frame ${item.startFrame}` : `the editor rejected ${describeSource(clip.from)}`,
      });
    }
  }
  return { doc, timelineId, trackCount: trackIds.length, itemCount };
}
