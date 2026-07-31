// Timeline difference of modified tools: after the tool is finished running, it directly tells the agent "what was actually changed", saving one time
// Full read_project also blocks silent errors such as "continue editing with expired coordinates".
//
// Compression is the key point: a ripple deletion will push dozens of clips behind the same track to the left as a whole. Listing them one by one is pure noise.
// (Also crowding out the context). The fragments of the same orbit and displacement are pressed into a rule, and only a few fragments are listed one by one.
import {
  timelineTrackIds,
  trackAlias,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';

interface Placement {
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
}

export interface TimelineSnapshot {
  placements: Map<string, Placement>;
  trackIds: TrackId[];
}

/** Only when the co-orbital and co-displacement amount reaches this amount can it be pressed into a rule; if it does not reach this amount, it will be listed one by one (easier to read). */
const SHIFT_GROUP_MIN = 3;
/** Change the upper limit of enumeration of fragments; if it exceeds the total number, only the total number will be reported and a re-read will be prompted. */
const MAX_CLIPS = 30;

const samePlace = (a: Placement, b: Placement): boolean =>
  a.track === b.track && a.startFrame === b.startFrame && a.durationInFrames === b.durationInFrames;

export function snapshotTimeline(state: TimelineState): TimelineSnapshot {
  const placements = new Map<string, Placement>();
  for (const it of state.items) {
    placements.set(it.id, {
      track: it.track,
      startFrame: it.startFrame,
      durationInFrames: it.durationInFrames,
    });
  }
  return { placements, trackIds: timelineTrackIds(state) };
}

/** A group of fragments on the same track and with the same displacement: count by frames starting from fromFrame. */
export interface ShiftRule {
  track: string;
  fromFrame: number;
  by: number;
  count: number;
}

/** Change the minimum available shape of the fragment, and the field name is consistent with read_project. */
export interface DeltaClip {
  id: string;
  track: string;
  name: string;
  kind: TimelineItem['kind'];
  startFrame: number;
  durationInFrames: number;
}

export interface TimelineDelta {
  clips?: DeltaClip[];
  shifted?: ShiftRule[];
  removedItemIds?: string[];
  createdTracks?: string[];
  notes?: string[];
}

/**
 * Timeline difference before and after tool execution; nothing changed (read-only tool) returns null.
 * `before` is taken from snapshotTimeline before tool execution.
 */
export function describeTimelineDelta(
  before: TimelineSnapshot,
  state: TimelineState,
): TimelineDelta | null {
  const after = snapshotTimeline(state);
  const changed = new Set<string>();
  const shifts = new Map<string, { from: number; by: number }>();

  for (const [id, now] of after.placements) {
    const was = before.placements.get(id);
    if (!was) { changed.add(id); continue; }          // New
    if (samePlace(was, now)) continue;
    if (was.track === now.track && was.durationInFrames === now.durationInFrames) {
      shifts.set(id, { from: was.startFrame, by: now.startFrame - was.startFrame });
    } else {
      changed.add(id);                                 // Change track/Change length = true change
    }
  }

  // Same orbit and same displacement are compressed in groups; sporadic returns are enumerated one by one.
  const grouped = new Map<string, string[]>();
  for (const [id, shift] of shifts) {
    const key = `${after.placements.get(id)!.track}|${shift.by}`;
    grouped.set(key, [...(grouped.get(key) ?? []), id]);
  }
  const shifted: ShiftRule[] = [];
  for (const ids of grouped.values()) {
    if (ids.length < SHIFT_GROUP_MIN) { for (const id of ids) changed.add(id); continue; }
    shifted.push({
      track: trackAlias(state, after.placements.get(ids[0]!)!.track),
      fromFrame: Math.min(...ids.map((id) => shifts.get(id)!.from)),
      by: shifts.get(ids[0]!)!.by,
      count: ids.length,
    });
  }
  shifted.sort((a, b) => (a.track === b.track ? a.fromFrame - b.fromFrame : a.track.localeCompare(b.track)));

  const removedItemIds = [...before.placements.keys()].filter((id) => !after.placements.has(id)).sort();
  const beforeTracks = new Set(before.trackIds);
  const createdTracks = after.trackIds.filter((id) => !beforeTracks.has(id)).map((id) => trackAlias(state, id));

  const byId = new Map(state.items.map((it) => [it.id, it]));
  const allChanged = [...changed]
    .map((id) => byId.get(id))
    .filter((it): it is TimelineItem => !!it)
    .sort((a, b) => (a.track === b.track ? a.startFrame - b.startFrame : a.track.localeCompare(b.track)));

  const notes: string[] = [];
  const clips: DeltaClip[] = allChanged.slice(0, MAX_CLIPS).map((it) => ({
    id: it.id,
    track: trackAlias(state, it.track),
    name: it.name,
    kind: it.kind,
    startFrame: it.startFrame,
    durationInFrames: it.durationInFrames,
  }));
  if (allChanged.length > clips.length) {
    notes.push(`共 ${allChanged.length} 个片段变更,这里只列前 ${clips.length} 个;其余请重新读取时间线。`);
  }
  // The number of tracks has changed = the old conclusion of positioning by alias/serial number may be invalid
  if (createdTracks.length || after.trackIds.length !== before.trackIds.length) {
    notes.push('轨道构成已变化,按轨道定位前请重新确认。');
  }

  const delta: TimelineDelta = {};
  if (clips.length) delta.clips = clips;
  if (shifted.length) delta.shifted = shifted;
  if (removedItemIds.length) delta.removedItemIds = removedItemIds;
  if (createdTracks.length) delta.createdTracks = createdTracks;
  if (notes.length) delta.notes = notes;
  return Object.keys(delta).length ? delta : null;
}
