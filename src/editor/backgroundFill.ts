import { defaultTrackId, type ClipFilters, type TimelineItem, type TimelineState } from './types';

const BLUR_RATIO = 0.035;
const MIN_BLUR_PX = 24;
const MAX_BLUR_PX = 64;
const BLUR_EDGE_SPAN = 4;

export interface BackgroundFillAppearance {
  blurPx: number;
  brightness: number;
  saturate: number;
  overscanScale: number;
}

export function isBackgroundFillEligible(state: TimelineState, item: TimelineItem): boolean {
  return (item.kind === 'video' || item.kind === 'image')
    && item.track === defaultTrackId(state, 'video');
}

export function isBackgroundFillActive(state: TimelineState, item: TimelineItem): boolean {
  return item.backgroundFill === true && !!item.src && isBackgroundFillEligible(state, item);
}

export function setBackgroundFillState(
  state: TimelineState,
  itemId: string,
  enabled: boolean,
): TimelineState {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || (enabled && !isBackgroundFillEligible(state, item))) return state;
  if ((item.backgroundFill === true) === enabled) return state;
  return {
    ...state,
    items: state.items.map((candidate) => {
      if (candidate.id !== itemId) return candidate;
      if (enabled) return { ...candidate, backgroundFill: true };
      const { backgroundFill: _backgroundFill, ...rest } = candidate;
      return rest;
    }),
  };
}

export function backgroundFillAppearance(width: number, height: number): BackgroundFillAppearance {
  const shortSide = Math.max(1, Math.min(width, height));
  const blurPx = Math.max(MIN_BLUR_PX, Math.min(MAX_BLUR_PX, Math.round(shortSide * BLUR_RATIO)));
  return {
    blurPx,
    brightness: 0.72,
    saturate: 0.9,
    overscanScale: 1 + (blurPx * BLUR_EDGE_SPAN) / shortSide,
  };
}

export function backgroundFillFilter(
  appearance: BackgroundFillAppearance,
  filters?: ClipFilters,
): string {
  return `brightness(${(filters?.brightness ?? 1) * appearance.brightness}) contrast(${filters?.contrast ?? 1}) saturate(${(filters?.saturate ?? 1) * appearance.saturate}) blur(${appearance.blurPx + (filters?.blur ?? 0)}px)`;
}
