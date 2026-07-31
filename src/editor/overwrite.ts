import { applyOverwriteLaneAction, type Action, type OverwriteLaneAction } from './reduce';
import { sourceWindowForTimelineRange } from './sourceLimit';
import type { TimelineItem, TimelineState } from './types';
import { hasOperationalTranscript } from '../transcript/types';

export interface OverwritePlan {
  actions: Action[];
  operations: OverwriteLaneAction[];
  preview: TimelineState;
}

function trimStartAction(item: TimelineItem, startFrame: number, endFrame: number): OverwriteLaneAction {
  const localStartFrame = startFrame - item.startFrame;
  const durationInFrames = endFrame - startFrame;
  const sourceWindow = sourceWindowForTimelineRange(
    item.kind === 'audio' && hasOperationalTranscript(item) ? { ...item, playbackRate: 1 } : item,
    localStartFrame,
    durationInFrames,
  );
  return {
    type: 'retime',
    id: item.id,
    startFrame,
    durationInFrames,
    ...((item.kind === 'video' || item.kind === 'audio') ? { srcInFrame: sourceWindow.startFrame } : {}),
  };
}

/**
 * Plan a rippleless overwrite on one lane. Every intersecting old clip falls
 * into exactly one region: remove, keep its right fragment, keep its left
 * fragment, or split around a middle hole. The inserted item is always last.
 */
export function planOverwrite(
  state: TimelineState,
  item: Omit<TimelineItem, 'startFrame'>,
  startFrame: number,
  nextId: () => string,
): OverwritePlan | null {
  const start = Math.max(0, Math.round(startFrame));
  const duration = Math.max(1, Math.round(item.durationInFrames));
  const end = start + duration;
  if (state.tracks?.[item.track]?.locked || state.items.some((candidate) => candidate.id === item.id)) return null;

  const usedIds = new Set(state.items.map((candidate) => candidate.id));
  usedIds.add(item.id);
  const freshId = (): string | null => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = nextId();
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
    return null;
  };

  const operations: OverwriteLaneAction[] = [];
  const intersecting = state.items
    .filter((candidate) => candidate.track === item.track
      && candidate.startFrame < end
      && candidate.startFrame + candidate.durationInFrames > start)
    .toSorted((left, right) => left.startFrame - right.startFrame);

  for (const existing of intersecting) {
    const existingStart = existing.startFrame;
    const existingEnd = existing.startFrame + existing.durationInFrames;
    if (start <= existingStart && end >= existingEnd) {
      operations.push({ type: 'remove', id: existing.id });
      continue;
    }
    if (start <= existingStart) {
      operations.push(trimStartAction(existing, end, existingEnd));
      continue;
    }
    if (end >= existingEnd) {
      operations.push({ type: 'retime', id: existing.id, durationInFrames: start - existingStart });
      continue;
    }

    const middleId = freshId();
    const rightId = freshId();
    if (!middleId || !rightId) return null;
    operations.push(
      { type: 'split', id: existing.id, atFrame: start, newId: middleId },
      { type: 'split', id: middleId, atFrame: end, newId: rightId },
      { type: 'remove', id: middleId },
    );
  }

  operations.push({ type: 'add', item: { ...item, durationInFrames: duration }, startFrame: start });
  let preview = state;
  for (const operation of operations) {
    const next = applyOverwriteLaneAction(preview, item.track, operation);
    if (!next) return null;
    preview = next;
  }
  return { actions: [{ type: 'setFullState', state: preview }], operations, preview };
}
