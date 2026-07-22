import { scaleItemKeyframes } from './keyframes';
import type { TimelineItem, TimelineState } from './types';

export type RateStretchEdge = 'left' | 'right';

const MIN_RATE = 0.1;
const MAX_RATE = 8;

export function rateStretchGeometry(
  item: TimelineItem,
  edge: RateStretchEdge,
  deltaFrames: number,
): Pick<TimelineItem, 'startFrame' | 'durationInFrames' | 'playbackRate'> {
  const sourceSpan = item.durationInFrames * (item.playbackRate ?? 1);
  const endFrame = item.startFrame + item.durationInFrames;
  const minDuration = Math.max(1, Math.ceil(sourceSpan / MAX_RATE));
  const maxByRate = Math.max(minDuration, Math.floor(sourceSpan / MIN_RATE));
  const maxDuration = edge === 'left' ? Math.min(maxByRate, endFrame) : maxByRate;
  const requested = item.durationInFrames + (edge === 'right' ? deltaFrames : -deltaFrames);
  const durationInFrames = Math.max(minDuration, Math.min(maxDuration, requested));
  const startFrame = edge === 'left' ? endFrame - durationInFrames : item.startFrame;
  return { startFrame, durationInFrames, playbackRate: sourceSpan / durationInFrames };
}

export function rateStretchItem(
  state: TimelineState,
  itemId: string,
  edge: RateStretchEdge,
  deltaFrames: number,
): TimelineState {
  const target = state.items.find((item) => item.id === itemId);
  if (!target || !['video', 'audio'].includes(target.kind) || state.tracks?.[target.track]?.locked) return state;
  const next = rateStretchGeometry(target, edge, deltaFrames);
  if (next.durationInFrames === target.durationInFrames) return state;
  const factor = next.durationInFrames / target.durationInFrames;
  return {
    ...state,
    items: state.items.map((item) => item.id === itemId ? {
      ...item,
      ...next,
      ...(item.keyframes ? { keyframes: scaleItemKeyframes(item.keyframes, factor) } : {}),
    } : item),
  };
}
