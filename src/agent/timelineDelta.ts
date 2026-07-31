// Compact, reconstructable timeline differences returned after mutating agent tools.
import { timelineTrackIds, trackAlias } from '../editor/types';
import type {
  ClipCrop,
  ClipEffect,
  ClipFilters,
  ClipTransform,
  ItemKeyframes,
  TimelineItem,
  TimelineState,
  TrackId,
  TransitionItem,
  ZoomEffect,
} from '../editor/types';

export interface Placement {
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
}

export interface TimelineItemChangeValueMap {
  name: string | null;
  kind: TimelineItem['kind'] | null;
  track: TrackId | null;
  startFrame: number | null;
  durationInFrames: number | null;
  text: unknown;
  src: string | null;
  opacity: unknown;
  volume: number | null;
  srcInFrame: number | null;
  fadeInFrames: number | null;
  fadeOutFrames: number | null;
  crop: ClipCrop | null;
  transform: Omit<ClipTransform, 'crop'> | null;
  props: Record<string, unknown> | null;
  keyframes: ItemKeyframes | null;
  filters: ClipFilters | null;
  zoom: ZoomEffect | null;
  effects: ClipEffect[] | null;
  playbackRate: number | null;
  templateId: string | null;
  code: string | null;
  denoisedSrc: string | null;
  denoiseStrength: number | null;
}

export type TimelineItemChange = {
  [Field in keyof TimelineItemChangeValueMap]: {
    entity: 'item';
    itemId: string;
    field: Field;
    before: TimelineItemChangeValueMap[Field];
    after: TimelineItemChangeValueMap[Field];
  }
}[keyof TimelineItemChangeValueMap];

export interface TimelineTransitionChange {
  entity: 'transition';
  transitionId: string;
  field: 'transition';
  before: TransitionItem | null;
  after: TransitionItem | null;
}

export type TimelineChange = TimelineItemChange | TimelineTransitionChange;

export interface TimelineSnapshot {
  placements: Map<string, Placement>;
  itemFields: Map<string, TimelineItemChangeValueMap>;
  transitions: Map<string, TransitionItem>;
  trackIds: TrackId[];
}

const SHIFT_GROUP_MIN = 3;
const MAX_CLIPS = 30;
const ITEM_FIELD_NAMES: readonly (keyof TimelineItemChangeValueMap)[] = [
  'name',
  'kind',
  'track',
  'startFrame',
  'durationInFrames',
  'text',
  'src',
  'opacity',
  'volume',
  'srcInFrame',
  'fadeInFrames',
  'fadeOutFrames',
  'crop',
  'transform',
  'props',
  'keyframes',
  'filters',
  'zoom',
  'effects',
  'playbackRate',
  'templateId',
  'code',
  'denoisedSrc',
  'denoiseStrength',
];

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]));
}

function snapshotItemFields(item: TimelineItem): TimelineItemChangeValueMap {
  const { text = null, opacity = null, ...otherProps } = item.props ?? {};
  const { crop = null, ...otherTransform } = item.transform ?? {};
  return {
    name: item.name,
    kind: item.kind,
    track: item.track,
    startFrame: item.startFrame,
    durationInFrames: item.durationInFrames,
    text,
    src: item.src ?? null,
    opacity,
    volume: item.volume ?? null,
    srcInFrame: item.srcInFrame ?? null,
    fadeInFrames: item.fadeInFrames ?? null,
    fadeOutFrames: item.fadeOutFrames ?? null,
    crop,
    transform: Object.keys(otherTransform).length ? otherTransform : null,
    props: Object.keys(otherProps).length ? otherProps : null,
    keyframes: item.keyframes ?? null,
    filters: item.filters ?? null,
    zoom: item.zoom ?? null,
    effects: item.effects ?? null,
    playbackRate: item.playbackRate ?? null,
    templateId: item.templateId ?? null,
    code: item.code ?? null,
    denoisedSrc: item.denoisedSrc ?? null,
    denoiseStrength: item.denoiseStrength ?? null,
  };
}

function snapshotTransition(transition: TransitionItem): TransitionItem {
  return {
    ...transition,
    ...(transition.customUniforms ? { customUniforms: { ...transition.customUniforms } } : {}),
  };
}

export function snapshotTimeline(state: TimelineState): TimelineSnapshot {
  const placements = new Map<string, Placement>();
  const itemFields = new Map<string, TimelineItemChangeValueMap>();
  for (const item of state.items) {
    placements.set(item.id, {
      track: item.track,
      startFrame: item.startFrame,
      durationInFrames: item.durationInFrames,
    });
    itemFields.set(item.id, snapshotItemFields(item));
  }
  const transitions = new Map(
    (state.transitions ?? []).map((transition) => [transition.id, snapshotTransition(transition)]),
  );
  return { placements, itemFields, transitions, trackIds: timelineTrackIds(state) };
}

/** A contiguous same-track range shifted by the same number of frames. */
export interface ShiftRule {
  track: string;
  fromFrame: number;
  by: number;
  count: number;
}

/** Final item placement, using the same track aliases as read_project. */
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
  changes?: TimelineChange[];
  removedItemIds?: string[];
  createdTracks?: string[];
  notes?: string[];
}

interface ShiftCandidate {
  id: string;
  before: Placement;
  after: Placement;
  by: number;
}

function changedFields(
  itemId: string,
  before: TimelineItemChangeValueMap,
  after: TimelineItemChangeValueMap,
): TimelineItemChange[] {
  const changes: TimelineItemChange[] = [];
  for (const field of ITEM_FIELD_NAMES) {
    if (valuesEqual(before[field], after[field])) continue;
    changes.push({
      entity: 'item',
      itemId,
      field,
      before: before[field],
      after: after[field],
    } as TimelineItemChange);
  }
  return changes;
}

function splitContiguousShiftRuns(
  candidates: ShiftCandidate[],
  before: TimelineSnapshot,
): ShiftCandidate[][] {
  const orderByTrack = new Map<TrackId, Map<string, number>>();
  for (const track of before.trackIds) {
    const ordered = [...before.placements]
      .filter(([, placement]) => placement.track === track)
      .sort((left, right) =>
        left[1].startFrame - right[1].startFrame || left[0].localeCompare(right[0]));
    orderByTrack.set(track, new Map(ordered.map(([id], index) => [id, index])));
  }
  const sorted = candidates.slice().sort((left, right) =>
    left.before.startFrame - right.before.startFrame || left.id.localeCompare(right.id));
  const runs: ShiftCandidate[][] = [];
  for (const candidate of sorted) {
    const run = runs[runs.length - 1];
    const prior = run?.[run.length - 1];
    const trackOrder = orderByTrack.get(candidate.before.track);
    const isNextItem = prior
      ? trackOrder?.get(candidate.id) === (trackOrder?.get(prior.id) ?? -2) + 1
      : false;
    const touchesPrior = prior
      ? candidate.before.startFrame === prior.before.startFrame + prior.before.durationInFrames
      : false;
    if (!prior || !isNextItem || !touchesPrior) runs.push([candidate]);
    else run.push(candidate);
  }
  return runs;
}

/**
 * Describe the difference between a pre-tool snapshot and the current state.
 * Property changes include typed before/after values; only geometrically and
 * ordinally contiguous shifts are compressed into range rules.
 */
export function describeTimelineDelta(
  before: TimelineSnapshot,
  state: TimelineState,
): TimelineDelta | null {
  const after = snapshotTimeline(state);
  const changedIds = new Set<string>();
  const itemChanges: TimelineItemChange[] = [];
  const startChanges = new Map<string, TimelineItemChange>();
  const shiftGroups = new Map<string, ShiftCandidate[]>();

  for (const [id, now] of after.itemFields) {
    const was = before.itemFields.get(id);
    if (!was) {
      changedIds.add(id);
      continue;
    }
    const changes = changedFields(id, was, now);
    if (!changes.length) continue;
    const beforePlacement = before.placements.get(id)!;
    const afterPlacement = after.placements.get(id)!;
    const canCompressStart = beforePlacement.track === afterPlacement.track
      && beforePlacement.durationInFrames === afterPlacement.durationInFrames
      && beforePlacement.startFrame !== afterPlacement.startFrame;
    if (canCompressStart) {
      const by = afterPlacement.startFrame - beforePlacement.startFrame;
      const key = `${afterPlacement.track}|${by}`;
      shiftGroups.set(key, [
        ...(shiftGroups.get(key) ?? []),
        { id, before: beforePlacement, after: afterPlacement, by },
      ]);
      const startChange = changes.find((change) => change.field === 'startFrame');
      if (startChange) startChanges.set(id, startChange);
      const propertyChanges = changes.filter((change) => change.field !== 'startFrame');
      if (propertyChanges.length) {
        changedIds.add(id);
        itemChanges.push(...propertyChanges);
      }
      continue;
    }
    changedIds.add(id);
    itemChanges.push(...changes);
  }

  const shifted: ShiftRule[] = [];
  for (const candidates of shiftGroups.values()) {
    for (const run of splitContiguousShiftRuns(candidates, before)) {
      if (run.length < SHIFT_GROUP_MIN) {
        for (const candidate of run) {
          changedIds.add(candidate.id);
          const change = startChanges.get(candidate.id);
          if (change) itemChanges.push(change);
        }
        continue;
      }
      shifted.push({
        track: trackAlias(state, run[0]!.after.track),
        fromFrame: run[0]!.before.startFrame,
        by: run[0]!.by,
        count: run.length,
      });
    }
  }
  shifted.sort((left, right) =>
    left.track === right.track
      ? left.fromFrame - right.fromFrame
      : left.track.localeCompare(right.track));

  const removedItemIds = [...before.placements.keys()]
    .filter((id) => !after.placements.has(id))
    .sort();
  const beforeTracks = new Set(before.trackIds);
  const createdTracks = after.trackIds
    .filter((id) => !beforeTracks.has(id))
    .map((id) => trackAlias(state, id));

  const byId = new Map(state.items.map((item) => [item.id, item]));
  const allChanged = [...changedIds]
    .map((id) => byId.get(id))
    .filter((item): item is TimelineItem => Boolean(item))
    .sort((left, right) =>
      left.track === right.track
        ? left.startFrame - right.startFrame
        : left.track.localeCompare(right.track));
  const clips: DeltaClip[] = allChanged.slice(0, MAX_CLIPS).map((item) => ({
    id: item.id,
    track: trackAlias(state, item.track),
    name: item.name,
    kind: item.kind,
    startFrame: item.startFrame,
    durationInFrames: item.durationInFrames,
  }));
  const listedIds = new Set(clips.map((clip) => clip.id));

  const transitionChanges: TimelineTransitionChange[] = [];
  const transitionIds = new Set([...before.transitions.keys(), ...after.transitions.keys()]);
  for (const transitionId of [...transitionIds].sort()) {
    const oldTransition = before.transitions.get(transitionId) ?? null;
    const newTransition = after.transitions.get(transitionId) ?? null;
    if (valuesEqual(oldTransition, newTransition)) continue;
    transitionChanges.push({
      entity: 'transition',
      transitionId,
      field: 'transition',
      before: oldTransition,
      after: newTransition,
    });
  }
  const changes: TimelineChange[] = [
    ...itemChanges
      .filter((change) => listedIds.has(change.itemId))
      .sort((left, right) =>
        left.itemId === right.itemId
          ? left.field.localeCompare(right.field)
          : left.itemId.localeCompare(right.itemId)),
    ...transitionChanges,
  ];

  const notes: string[] = [];
  if (allChanged.length > clips.length) {
    notes.push(`共 ${allChanged.length} 个片段变更,这里只列前 ${clips.length} 个;其余请重新读取时间线。`);
  }
  const trackOrderChanged = after.trackIds.some((id, index) => {
    const previousIndex = before.trackIds.indexOf(id);
    return previousIndex !== -1 && previousIndex !== index;
  });
  if (createdTracks.length || trackOrderChanged || after.trackIds.length !== before.trackIds.length) {
    notes.push('轨道构成已变化（包含顺序变化），按轨道定位前请重新确认。');
  }

  const delta: TimelineDelta = {};
  if (clips.length) delta.clips = clips;
  if (shifted.length) delta.shifted = shifted;
  if (changes.length) delta.changes = changes;
  if (removedItemIds.length) delta.removedItemIds = removedItemIds;
  if (createdTracks.length) delta.createdTracks = createdTracks;
  if (notes.length) delta.notes = notes;
  return Object.keys(delta).length ? delta : null;
}
