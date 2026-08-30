import type { MediaAsset, MediaAssetRelinkPatch, TimelineItem, TimelineState, TrackId, TrackKind } from './types';
import { defaultTrackId, timelineTrackIds, trackKind } from './types';
import { remainingSourceFrames, sourceFramesToTimelineFrames, timelineFramesToSourceFrames } from './sourceLimit';
import { editedFrames, itemEditOpts } from '../transcript/edit';
import { hasOperationalTranscript } from '../transcript/types';
import type { CaptionsData } from '../captions/types';
import type { Action } from './reducerActions';

const TRACK_KIND_ORDER: readonly TrackKind[] = ['caption', 'video', 'audio'];

export function placeTrack(s: TimelineState, track: TrackId, kind: TrackKind, order?: number): TrackId[] {
  const groups = Object.fromEntries(TRACK_KIND_ORDER.map((entry) => [
    entry,
    timelineTrackIds(s).filter((id) => id !== track && trackKind(s, id) === entry),
  ])) as Record<TrackKind, TrackId[]>;
  const lane = groups[kind];
  const sourceOrder = Math.max(0, Math.min(order ?? lane.length, lane.length));
  lane.splice(kind === 'video' ? lane.length - sourceOrder : sourceOrder, 0, track);
  return TRACK_KIND_ORDER.flatMap((entry) => groups[entry]);
}

export function withTrackCaptions(s: TimelineState, captions: CaptionsData | null, track?: TrackId): TimelineState {
  const target = track ?? defaultTrackId(s, 'caption');
  if (!target) return { ...s, captions };
  const current = s.tracks?.[target] ?? { kind: 'caption' as const };
  const next = { ...s, tracks: { ...s.tracks, [target]: { ...current, captions } } };
  return target === defaultTrackId(s, 'caption') ? { ...next, captions } : next;
}

export const EMPTY_CURVE = { version: 1, timebase: 'effect-frame', coordinateSpace: 'composition-normalized', keyframes: [] } as const;

/** True when the item sits on a locked track; modifications must no-op. */
export const lockedItem = (s: TimelineState, id: string): boolean =>
  s.items.some((it) => it.id === id && s.tracks?.[it.track]?.locked);

export type RelinkableTimelineItem = TimelineItem & Pick<MediaAssetRelinkPatch, 'sourceSize' | 'sourceModifiedAt'> & {
  sourceTimecode?: MediaAsset['sourceTimecode'];
  captureClock?: MediaAsset['captureClock'];
};

export function isRelinkableMediaKind(
  kind: TimelineItem['kind'],
): kind is Extract<MediaAsset['kind'], TimelineItem['kind']> {
  return kind === 'video'
    || kind === 'image'
    || kind === 'audio'
    || kind === 'motion-graphic'
    || kind === 'gif'
    || kind === 'svg';
}

/**
 * Preserve the authored timeline slot and source window whenever the new file
 * contains that window. A shorter source may only move the source window left
 * or shorten the clip; it must never grow the timeline slot.
 */
export function relinkTiming(
  item: TimelineItem,
  replacementDurationInFrames: number | undefined,
  replacementKind: MediaAsset['kind'],
): Pick<TimelineItem, 'durationInFrames' | 'srcInFrame'> | null {
  if (replacementDurationInFrames === undefined) {
    return { durationInFrames: item.durationInFrames, srcInFrame: item.srcInFrame };
  }
  if (!Number.isFinite(replacementDurationInFrames) || replacementDurationInFrames < 1) return null;
  if (replacementKind !== 'video' && replacementKind !== 'audio') {
    return { durationInFrames: item.durationInFrames, srcInFrame: item.srcInFrame };
  }

  const sourceDuration = Math.max(1, Math.floor(replacementDurationInFrames));
  const sourceStart = Math.max(0, item.srcInFrame ?? 0);
  const authoredSourceLength = timelineFramesToSourceFrames(item, item.durationInFrames);
  if (sourceStart + authoredSourceLength <= sourceDuration) {
    return { durationInFrames: item.durationInFrames, srcInFrame: item.srcInFrame };
  }
  if (authoredSourceLength <= sourceDuration) {
    const srcInFrame = Math.max(0, Math.floor(sourceDuration - authoredSourceLength));
    return {
      durationInFrames: item.durationInFrames,
      srcInFrame: item.srcInFrame === undefined && srcInFrame === 0 ? undefined : srcInFrame,
    };
  }
  return {
    durationInFrames: Math.min(
      item.durationInFrames,
      Math.max(1, Math.floor(sourceFramesToTimelineFrames(item, sourceDuration))),
    ),
    srcInFrame: item.srcInFrame === undefined ? undefined : 0,
  };
}

// recompute a transcript-edited clip's duration under its current edit state


export function editedDuration(it: TimelineItem, deleted: Set<number>, fps: number): number {
  if (!hasOperationalTranscript(it)) return it.durationInFrames;
  // Duration after word operation = Full length of word stream after editing − There is left clipping (only audio: the starting point of the window for word-driven rendering).
  // The left trim is retained after word deletion/silencing; the right trim is reset to "all remaining". video+transcript go
  // Continuous rendering, srcInFrame is media frame semantics and does not participate in the word flow window.
  const trim = it.kind === 'audio' ? (it.srcInFrame ?? 0) : 0;
  return Math.max(1, editedFrames(it.transcript!, deleted, fps, itemEditOpts(it)) - trim);
}

/**
 * Starting from `fromFrame`, collect the following same-track connected chain
 * until the first gap. Legacy overlapping clips still count as connected so
 * ripple edits can safely repair old project data.
 */
export function contiguousFollowers(
  items: readonly TimelineItem[],
  track: TrackId,
  fromFrame: number,
): Set<string> {
  const later = items
    .filter((it) => it.track === track && it.startFrame >= fromFrame)
    .toSorted((x, y) => x.startFrame - y.startFrame);
  const ids = new Set<string>();
  let chainEnd = fromFrame;
  for (const it of later) {
    if (it.startFrame > chainEnd) break;
    ids.add(it.id);
    chainEnd = Math.max(chainEnd, it.startFrame + it.durationInFrames);
  }
  return ids;
}

type RetimeAction = Extract<Action, { type: 'retime' }>;
export type OverwriteLaneAction = Extract<Action, { type: 'add' | 'retime' | 'remove' | 'split' }>;
type RetimePatch = Pick<TimelineItem, 'startFrame' | 'durationInFrames' | 'srcInFrame'>;

export function retimePatchForItem(s: TimelineState, target: TimelineItem, action: RetimeAction): RetimePatch {
  // Timeline-domain values are integral frames; round action inputs so a
  // fractional tool argument never enters the document. srcInFrame stays
  // unrounded: the source domain is legitimately fractional under playbackRate.
  let srcInFrame = action.srcInFrame === undefined ? target.srcInFrame : Math.max(0, action.srcInFrame);
  let durationInFrames = Math.max(1, action.durationInFrames === undefined
    ? target.durationInFrames
    : Math.round(action.durationInFrames));
  if (target.kind === 'audio' && hasOperationalTranscript(target)) {
    const total = editedFrames(
      target.transcript,
      new Set(target.deletedWordIdx ?? []),
      s.fps,
      itemEditOpts(target),
    );
    srcInFrame = Math.min(srcInFrame ?? 0, Math.max(0, total - 1));
    durationInFrames = Math.min(durationInFrames, Math.max(1, total - srcInFrame));
  }
  const sourceLimit = remainingSourceFrames(target, srcInFrame ?? 0, s.assets);
  if (sourceLimit !== null) durationInFrames = Math.min(durationInFrames, sourceLimit);
  return {
    startFrame: Math.max(0, action.startFrame === undefined
      ? target.startFrame
      : Math.round(action.startFrame)),
    durationInFrames,
    srcInFrame,
  };
}
