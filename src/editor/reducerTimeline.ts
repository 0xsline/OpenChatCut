import type { TimelineState } from './types';
import { selectedIdsOf } from './types';
import { fitTimelineItems } from './clipFit';
import { reconcileTransitions } from './transitionReconcile';
import { introducesTrackOverlap } from './trackCollision';
import { removeItemsWithGroups } from './linkGroups';
import type { Action } from './reducerActions';
import { TRANSITION_RECONCILING_ACTIONS } from './reducerActions';
import { applyClipAction } from './reducerClipActions';
import { applyTrackAction } from './reducerTrackActions';
import { applyTranscriptAction } from './reducerTranscriptActions';
import { OVERLAP_GUARDED_ACTIONS, remapSplitTransitionEndpoints, splitTimelineItem } from './reducerOverwrite';
import { remapSplitTimelineCaptionReferences } from '../captions/reconcileSources';

export function reduce(s: TimelineState, a: Action): TimelineState {
  const applied = fitTimelineItems(applyAction(s, a));
  const next = OVERLAP_GUARDED_ACTIONS.has(a.type) && introducesTrackOverlap(s, applied)
    ? s
    : applied;
  if (!TRANSITION_RECONCILING_ACTIONS.has(a.type) || !next.transitions?.length) return next;
  return { ...next, transitions: reconcileTransitions(next.items, next.transitions) };
}

function applyAction(s: TimelineState, a: Action): TimelineState {
  const delegated = applyClipAction(s, a)
    ?? applyTrackAction(s, a, reduce)
    ?? applyTranscriptAction(s, a);
  if (delegated) return delegated;
  switch (a.type) {
    case 'remove':
      return removeItemsWithGroups(s, [a.id], a.ripple);
    case 'split': {
      const item = s.items.find((candidate) => candidate.id === a.id);
      if (!item || s.tracks?.[item.track]?.locked
        || !a.newId || s.items.some((candidate) => candidate.id === a.newId)
        || !Number.isFinite(a.atFrame)
        || a.atFrame <= item.startFrame
        || a.atFrame >= item.startFrame + item.durationInFrames) return s;
      const [left, right] = splitTimelineItem(s, item, a.atFrame, a.newId);
      return remapSplitTimelineCaptionReferences({
        ...s,
        items: s.items.flatMap((candidate) => candidate.id === a.id ? [left, right] : [candidate]),
        transitions: remapSplitTransitionEndpoints(s.transitions, item.id, right.id),
      }, item.id, right.id);
    }
    case 'select': {
      if (a.id === null) return { ...s, selectedId: null, selectedIds: [] };
      const mode = a.mode ?? 'replace';
      let ids = selectedIdsOf(s);
      if (mode === 'replace') ids = [a.id];
      else if (mode === 'toggle') {
        ids = ids.includes(a.id) ? ids.filter((id) => id !== a.id) : [...ids, a.id];
      } else if (mode === 'add') {
        if (!ids.includes(a.id)) ids = [...ids, a.id];
      }
      // drop ids that no longer exist
      const live = new Set(s.items.map((it) => it.id));
      ids = ids.filter((id) => live.has(id));
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'selectMany': {
      const live = new Set(s.items.map((it) => it.id));
      const ids = a.ids.filter((id) => live.has(id));
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'selectAll': {
      const ids = s.items.map((it) => it.id);
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'setFullState':
      return a.state; // atomic commit of a proposal's result (one history step)
    default:
      return s;
  }
}
