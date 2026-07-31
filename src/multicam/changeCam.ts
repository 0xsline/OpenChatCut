import { coveredFrames, planCamSwitch } from '../editor/camSwitch';
import { reduce, type Action } from '../editor/reduce';
import { unlinkItems } from '../editor/linkGroups';
import type { MulticamAngle, MulticamGroup, TimelineItem, TimelineState } from '../editor/types';
import { multicamItemsForAngle, multicamItemsForGroup, replaceAngleDecision } from './groups';

export interface PersistentCamSwitchResult {
  nextState: TimelineState;
  group: MulticamGroup;
  angle: MulticamAngle;
  removed: Array<{ itemId: string; fromFrame: number; toFrame: number }>;
  restoredItemIds: string[];
}

export type PersistentCamSwitchPlan = PersistentCamSwitchResult | { error: string };

function uncoveredRanges(
  spans: readonly Pick<TimelineItem, 'startFrame' | 'durationInFrames'>[],
  fromFrame: number,
  toFrame: number,
): Array<{ fromFrame: number; toFrame: number }> {
  const covered = spans
    .map((span) => ({
      fromFrame: Math.max(fromFrame, span.startFrame),
      toFrame: Math.min(toFrame, span.startFrame + span.durationInFrames),
    }))
    .filter((span) => span.toFrame > span.fromFrame)
    .sort((a, b) => a.fromFrame - b.fromFrame);
  const gaps: Array<{ fromFrame: number; toFrame: number }> = [];
  let cursor = fromFrame;
  for (const span of covered) {
    if (span.fromFrame > cursor) gaps.push({ fromFrame: cursor, toFrame: span.fromFrame });
    cursor = Math.max(cursor, span.toFrame);
  }
  if (cursor < toFrame) gaps.push({ fromFrame: cursor, toFrame });
  return gaps;
}

function restoreActions(
  source: TimelineItem,
  groupId: string,
  angleId: string,
  fromFrame: number,
  toFrame: number,
  makeId: () => string,
): { actions: Action[]; keptId: string } {
  const sourceEnd = source.startFrame + source.durationInFrames;
  const fullId = makeId();
  const { startFrame: _sourceStart, ...sourceWithoutStart } = source;
  const actions: Action[] = [{
    type: 'add',
    item: {
      ...sourceWithoutStart,
      id: fullId,
      multicamGroupId: groupId,
      multicamAngleId: angleId,
    },
    startFrame: source.startFrame,
  }];
  let keptId = fullId;
  if (fromFrame > source.startFrame) {
    keptId = makeId();
    actions.push({ type: 'split', id: fullId, atFrame: fromFrame, newId: keptId });
    actions.push({ type: 'remove', id: fullId });
  }
  if (toFrame < sourceEnd) {
    const tailId = makeId();
    actions.push({ type: 'split', id: keptId, atFrame: toFrame, newId: tailId });
    actions.push({ type: 'remove', id: tailId });
  }
  return { actions, keptId };
}

function plannedActionTracks(state: TimelineState, actions: readonly Action[]): Set<string> | null {
  const trackByItemId = new Map<string, string>();
  for (const item of state.items) {
    if (!trackByItemId.has(item.id)) trackByItemId.set(item.id, item.track);
  }
  const tracks = new Set<string>();
  for (const action of actions) {
    if (action.type === 'add') {
      if (trackByItemId.has(action.item.id)) return null;
      tracks.add(action.item.track);
      trackByItemId.set(action.item.id, action.item.track);
      continue;
    }
    if (action.type === 'split') {
      const track = trackByItemId.get(action.id);
      if (track === undefined || trackByItemId.has(action.newId)) return null;
      tracks.add(track);
      trackByItemId.set(action.newId, track);
      continue;
    }
    if (action.type === 'remove') {
      const track = trackByItemId.get(action.id);
      if (track === undefined) return null;
      tracks.add(track);
      trackByItemId.delete(action.id);
      continue;
    }
    return null;
  }
  return tracks;
}

function plannedActionApplied(before: TimelineState, after: TimelineState, action: Action): boolean {
  if (action.type === 'add') {
    const beforeMatches = before.items.filter((item) => item.id === action.item.id);
    const afterMatches = after.items.filter((item) => item.id === action.item.id);
    const added = afterMatches[0];
    return beforeMatches.length === 0
      && afterMatches.length === 1
      && action.startFrame !== undefined
      && added?.track === action.item.track
      && added.startFrame === action.startFrame
      && added.durationInFrames === action.item.durationInFrames;
  }
  if (action.type === 'split') {
    const beforeMatches = before.items.filter((item) => item.id === action.id);
    const existingNewIds = before.items.filter((item) => item.id === action.newId);
    const leftMatches = after.items.filter((item) => item.id === action.id);
    const rightMatches = after.items.filter((item) => item.id === action.newId);
    const source = beforeMatches[0];
    const left = leftMatches[0];
    const right = rightMatches[0];
    return beforeMatches.length === 1
      && existingNewIds.length === 0
      && leftMatches.length === 1
      && rightMatches.length === 1
      && source !== undefined
      && left?.track === source.track
      && left.startFrame === source.startFrame
      && left.durationInFrames === action.atFrame - source.startFrame
      && right?.track === source.track
      && right.startFrame === action.atFrame
      && right.durationInFrames === source.startFrame + source.durationInFrames - action.atFrame;
  }
  if (action.type === 'remove') {
    return before.items.filter((item) => item.id === action.id).length === 1
      && !after.items.some((item) => item.id === action.id);
  }
  return false;
}

function applyPlannedActions(state: TimelineState, actions: readonly Action[]): TimelineState | null {
  let working = state;
  for (const action of actions) {
    const next = reduce(working, action);
    if (!plannedActionApplied(working, next, action)) return null;
    working = next;
  }
  return working;
}

/**
 * Plan and simulate a right-open camera decision. No live state is touched until
 * the caller submits `nextState`, so any validation/planning failure is atomic.
 */
export function planPersistentCamSwitch(args: {
  state: TimelineState;
  groupId: string;
  angleId: string;
  fromFrame: number;
  toFrame: number;
  makeId: () => string;
}): PersistentCamSwitchPlan {
  const { state, fromFrame, toFrame, makeId } = args;
  const group = state.multicamGroups?.find((entry) => entry.id === args.groupId);
  if (!group) return { error: `multicam group not found: ${args.groupId}` };
  const angle = group.angles.find((entry) => entry.id === args.angleId || entry.itemId === args.angleId);
  if (!angle) return { error: `angle not found in group: ${args.angleId}` };
  if (!Number.isInteger(fromFrame) || !Number.isInteger(toFrame) || fromFrame < 0 || toFrame <= fromFrame) {
    return { error: 'camera switch requires an integer [fromFrame,toFrame) range' };
  }
  const sourceEnd = angle.source.startFrame + angle.source.durationInFrames;
  if (fromFrame < angle.source.startFrame || toFrame > sourceEnd) {
    return { error: 'target angle source does not cover the complete switch range' };
  }
  const otherAngles = group.angles.filter((entry) => entry.id !== angle.id && entry.source.kind === 'video');
  if (!otherAngles.length) return { error: 'multicam group needs at least two video angles to switch' };

  const groupItems = multicamItemsForGroup(state, group);
  const currentTargets = multicamItemsForAngle(state, group, angle);
  const restore: Action[] = [];
  const restoredItemIds: string[] = [];
  for (const gap of uncoveredRanges(currentTargets, fromFrame, toFrame)) {
    const planned = restoreActions(angle.source, group.id, angle.id, gap.fromFrame, gap.toFrame, makeId);
    restore.push(...planned.actions);
    restoredItemIds.push(planned.keptId);
  }

  const otherAngleIds = new Set(otherAngles.map((entry) => entry.id));
  const otherItemIds = new Set(otherAngles.map((entry) => entry.itemId));
  const others = groupItems.filter((item) =>
    (item.multicamAngleId !== undefined && otherAngleIds.has(item.multicamAngleId))
    || otherItemIds.has(item.id));
  const removal = planCamSwitch(currentTargets, others, fromFrame, toFrame, makeId);
  const affectedTracks = plannedActionTracks(state, [...restore, ...removal.actions]);
  if (!affectedTracks) return { error: 'failed to plan complete multicam switch actions' };
  for (const item of groupItems) affectedTracks.add(item.track);
  if ([...affectedTracks].some((track) => state.tracks?.[track]?.locked)) {
    return { error: 'a multicam angle track is locked' };
  }

  const restored = applyPlannedActions(state, restore);
  if (!restored) return { error: 'failed to apply planned multicam restoration' };
  let working = restored;
  const restoredTargets = multicamItemsForAngle(working, group, angle);
  if (uncoveredRanges(restoredTargets, fromFrame, toFrame).length > 0) {
    return { error: 'failed to restore complete target angle coverage' };
  }

  working = unlinkItems(
    working,
    removal.actions.filter((action) => action.type === 'remove').map((action) => action.id),
    'linked',
  );
  const removed = applyPlannedActions(working, removal.actions);
  if (!removed) return { error: 'failed to apply planned multicam removal' };
  working = removed;

  const selectedAfter = multicamItemsForAngle(working, group, angle);
  if (uncoveredRanges(selectedAfter, fromFrame, toFrame).length > 0) {
    return { error: 'selected multicam angle does not cover the complete switch range' };
  }
  const groupItemsAfter = multicamItemsForGroup(working, group);
  const othersAfter = groupItemsAfter.filter((item) =>
    (item.multicamAngleId !== undefined && otherAngleIds.has(item.multicamAngleId))
    || otherItemIds.has(item.id));
  if (coveredFrames(othersAfter, fromFrame, toFrame) !== 0) {
    return { error: 'other multicam angles still cover the switch range' };
  }

  const decision = {
    id: makeId(),
    fromFrame,
    toFrame,
    angleId: angle.id,
  };
  const updatedGroup: MulticamGroup = {
    ...group,
    decisions: replaceAngleDecision(group.decisions, decision, makeId),
  };
  const nextState: TimelineState = {
    ...working,
    multicamGroups: (working.multicamGroups ?? []).map((entry) => entry.id === group.id ? updatedGroup : entry),
  };
  return { nextState, group: updatedGroup, angle, removed: removal.removed, restoredItemIds };
}
