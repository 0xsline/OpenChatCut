import type { TimelineItem, TimelineLinkGroup, TimelineLinkMode, TimelineState, TrackId } from './types.js';
import { sourceFramesToTimelineFrames, timelineFramesToSourceFrames } from './sourceLimit.js';
import { clampMoveDeltaToTrackGaps } from './trackCollision';

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];
const LINKED_MODES: ReadonlySet<TimelineLinkMode> = new Set(['linked']);
const MOVE_LOCK_MODES: ReadonlySet<TimelineLinkMode> = new Set(['linked', 'sync-lock']);

function memberIds(
  state: Pick<TimelineState, 'linkGroups'>,
  seeds: readonly string[],
  modes: ReadonlySet<TimelineLinkMode>,
): string[] {
  const result = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of state.linkGroups ?? []) {
      if (!modes.has(group.mode) || !group.itemIds.some((id) => result.has(id))) continue;
      for (const id of group.itemIds) {
        if (result.has(id)) continue;
        result.add(id);
        changed = true;
      }
    }
  }
  return [...result];
}

export function linkedItemIds(state: Pick<TimelineState, 'linkGroups'>, seeds: readonly string[]): string[] {
  return memberIds(state, seeds, LINKED_MODES);
}

export function moveLockedItemIds(state: Pick<TimelineState, 'linkGroups'>, seeds: readonly string[]): string[] {
  return memberIds(state, seeds, MOVE_LOCK_MODES);
}

export function maintainLinkGroups(
  groups: readonly TimelineLinkGroup[] | undefined,
  remainingItemIds: ReadonlySet<string>,
): TimelineLinkGroup[] | undefined {
  if (!groups) return undefined;
  const next = groups.flatMap((group) => {
    const itemIds = unique(group.itemIds).filter((id) => remainingItemIds.has(id));
    if (itemIds.length < 2) return [];
    return [{ ...group, itemIds, anchorItemId: itemIds.includes(group.anchorItemId) ? group.anchorItemId : itemIds[0]! }];
  });
  return next.length ? next : undefined;
}

export function setLinkGroup(
  state: TimelineState,
  input: { id: string; itemIds: readonly string[]; anchorItemId?: string; mode: TimelineLinkMode },
): TimelineState {
  const existingIds = new Set(state.items.map((item) => item.id));
  const itemIds = unique(input.itemIds).filter((id) => existingIds.has(id));
  if (itemIds.length < 2) return state;
  const anchorItemId = input.anchorItemId && itemIds.includes(input.anchorItemId)
    ? input.anchorItemId
    : itemIds[0]!;
  const withoutMembers = (state.linkGroups ?? []).flatMap((group) => {
    if (group.mode !== input.mode && group.id !== input.id) return [group];
    const kept = group.itemIds.filter((id) => !itemIds.includes(id));
    if (kept.length < 2 || group.id === input.id) return [];
    return [{ ...group, itemIds: kept, anchorItemId: kept.includes(group.anchorItemId) ? group.anchorItemId : kept[0]! }];
  });
  return {
    ...state,
    linkGroups: [...withoutMembers, { id: input.id, itemIds, anchorItemId, mode: input.mode }],
  };
}

export function unlinkItems(
  state: TimelineState,
  itemIds: readonly string[],
  mode?: TimelineLinkMode,
): TimelineState {
  const removed = new Set(itemIds);
  const next = (state.linkGroups ?? []).flatMap((group) => {
    if (mode && group.mode !== mode) return [group];
    const kept = group.itemIds.filter((id) => !removed.has(id));
    if (kept.length < 2) return [];
    return [{ ...group, itemIds: kept, anchorItemId: kept.includes(group.anchorItemId) ? group.anchorItemId : kept[0]! }];
  });
  if (next.length === (state.linkGroups ?? []).length
    && next.every((group, index) => group === state.linkGroups?.[index])) return state;
  return { ...state, linkGroups: next.length ? next : undefined };
}

function locked(state: TimelineState, ids: ReadonlySet<string>, destinationTrack?: TrackId): boolean {
  if (destinationTrack && state.tracks?.[destinationTrack]?.locked) return true;
  return state.items.some((item) => ids.has(item.id) && state.tracks?.[item.track]?.locked);
}


/** Move a direct edit and every linked/sync-locked member by one shared, non-overlapping delta. */
export function moveItemWithGroups(
  state: TimelineState,
  id: string,
  nextStartFrame: number,
  destinationTrack?: TrackId,
): TimelineState {
  const target = state.items.find((item) => item.id === id);
  if (!target) return state;
  const ids = new Set(moveLockedItemIds(state, [id]));
  if (locked(state, ids, destinationTrack)) return state;
  const requestedDelta = nextStartFrame - target.startFrame;
  if (requestedDelta === 0 && (!destinationTrack || destinationTrack === target.track)) return state;
  const moving = state.items
    .filter((item) => ids.has(item.id))
    .map((item) => item.id === id && destinationTrack ? { ...item, track: destinationTrack } : item);
  const delta = clampMoveDeltaToTrackGaps(state, moving, ids, requestedDelta);
  if (delta === null) return state;
  const replacements = new Map(moving.map((item) => [
    item.id,
    { ...item, startFrame: item.startFrame + delta },
  ]));
  return {
    ...state,
    items: state.items.map((item) => replacements.get(item.id) ?? item),
  };
}

/**
 * Apply a trim to linked members using source-domain math. The direct clip's
 * source delta is converted back to timeline time before it is projected into
 * each follower's source rate, so mixed playback rates do not drift.
 */
export function retimeItemWithGroups(
  state: TimelineState,
  id: string,
  targetPatch: Pick<TimelineItem, 'startFrame' | 'durationInFrames' | 'srcInFrame'>,
): TimelineState | null {
  const target = state.items.find((item) => item.id === id);
  if (!target) return state;
  const ids = new Set(linkedItemIds(state, [id]));
  if (locked(state, ids)) return state;
  if (ids.size === 1) {
    return { ...state, items: state.items.map((item) => item.id === id ? { ...item, ...targetPatch } : item) };
  }

  const startDelta = targetPatch.startFrame - target.startFrame;
  const oldEnd = target.startFrame + target.durationInFrames;
  const endDelta = targetPatch.startFrame + targetPatch.durationInFrames - oldEnd;
  const sourceDelta = (targetPatch.srcInFrame ?? 0) - (target.srcInFrame ?? 0);
  const sourceTimelineDelta = sourceFramesToTimelineFrames(target, sourceDelta);
  const replacements = new Map<string, TimelineItem>([[id, { ...target, ...targetPatch }]]);

  for (const item of state.items) {
    if (!ids.has(item.id) || item.id === id) continue;
    const nextStart = item.startFrame + startDelta;
    const nextDuration = item.durationInFrames + endDelta - startDelta;
    const nextSrcIn = (item.srcInFrame ?? 0) + timelineFramesToSourceFrames(item, sourceTimelineDelta);
    if (nextStart < 0 || nextDuration < 1 || nextSrcIn < 0) return null;
    replacements.set(item.id, {
      ...item,
      startFrame: nextStart,
      durationInFrames: nextDuration,
      srcInFrame: nextSrcIn,
    });
  }
  return { ...state, items: state.items.map((item) => replacements.get(item.id) ?? item) };
}

/** Expand ripple shifts across sync-lock groups; conflicting deltas reject the edit. */
export function expandSyncLockShifts(
  state: Pick<TimelineState, 'linkGroups'>,
  initial: ReadonlyMap<string, number>,
): Map<string, number> | null {
  const shifts = new Map(initial);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of state.linkGroups ?? []) {
      if (group.mode !== 'sync-lock') continue;
      const deltas = [...new Set(group.itemIds.flatMap((id) => shifts.has(id) ? [shifts.get(id)!] : []))];
      if (!deltas.length) continue;
      if (deltas.length > 1) return null;
      const delta = deltas[0]!;
      for (const id of group.itemIds) {
        const current = shifts.get(id);
        if (current !== undefined && current !== delta) return null;
        if (current === undefined) {
          shifts.set(id, delta);
          changed = true;
        }
      }
    }
  }
  return shifts;
}

export function applyRippleShifts(
  state: TimelineState,
  initial: ReadonlyMap<string, number>,
  protectedIds: ReadonlySet<string> = new Set<string>(),
): TimelineState | null {
  const shifts = expandSyncLockShifts(state, initial);
  if (!shifts) return null;
  for (const item of state.items) {
    const delta = shifts.get(item.id);
    if (delta === undefined || protectedIds.has(item.id)) continue;
    if (state.tracks?.[item.track]?.locked || item.startFrame + delta < 0) return null;
  }
  if ([...protectedIds].some((id) => shifts.has(id))) return null;
  return {
    ...state,
    items: state.items.map((item) => {
      const delta = shifts.get(item.id);
      return delta === undefined ? item : { ...item, startFrame: item.startFrame + delta };
    }),
  };
}

/** Remove linked members together and propagate ripple deltas through sync locks. */
export function removeItemsWithGroups(
  state: TimelineState,
  seedIds: readonly string[],
  ripple = false,
): TimelineState {
  const removeIds = new Set(linkedItemIds(state, seedIds));
  const removed = state.items.filter((item) => removeIds.has(item.id));
  if (!removed.length || removed.some((item) => state.tracks?.[item.track]?.locked)) return state;

  let next: TimelineState = { ...state, items: state.items.filter((item) => !removeIds.has(item.id)) };
  if (ripple) {
    const baseShifts = new Map<string, number>();
    for (const gone of removed) {
      const end = gone.startFrame + gone.durationInFrames;
      for (const item of state.items) {
        if (removeIds.has(item.id) || item.track !== gone.track || item.startFrame < end) continue;
        baseShifts.set(item.id, (baseShifts.get(item.id) ?? 0) - gone.durationInFrames);
      }
    }
    const shifted = applyRippleShifts(next, baseShifts);
    if (!shifted) return state;
    next = shifted;
  }
  const remainingIds = new Set(next.items.map((item) => item.id));
  const selectedIds = (state.selectedIds ?? (state.selectedId ? [state.selectedId] : []))
    .filter((id) => remainingIds.has(id));
  return {
    ...next,
    transitions: (state.transitions ?? []).filter((transition) =>
      !removeIds.has(transition.incomingItemId) && !removeIds.has(transition.outgoingItemId)),
    linkGroups: maintainLinkGroups(state.linkGroups, remainingIds),
    selectedIds,
    selectedId: selectedIds[selectedIds.length - 1] ?? null,
  };
}
