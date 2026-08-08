import {
  defaultTrackId,
  type ClipFilters,
  type TimelineItem,
  type TimelineState,
} from './types';

const BLUR_EDGE_SPAN = 4;

interface BackgroundFillDefinition {
  blurRatio: number;
  minBlurPx: number;
  maxBlurPx: number;
  brightness: number;
  saturate: number;
}

export const DEFAULT_BACKGROUND_FILL_STRENGTH = 50;
const MIN_STRENGTH = 0;
const MAX_STRENGTH = 100;
const EMPTY_DEFINITION: BackgroundFillDefinition = {
  blurRatio: 0, minBlurPx: 0, maxBlurPx: 0, brightness: 1, saturate: 1,
};
const SOFT_DEFINITION: BackgroundFillDefinition = {
  blurRatio: 0.02, minBlurPx: 14, maxBlurPx: 40, brightness: 0.82, saturate: 0.96,
};
const DEFAULT_DEFINITION: BackgroundFillDefinition = {
  blurRatio: 0.035, minBlurPx: 24, maxBlurPx: 64, brightness: 0.72, saturate: 0.9,
};
const STRONG_DEFINITION: BackgroundFillDefinition = {
  blurRatio: 0.05, minBlurPx: 34, maxBlurPx: 84, brightness: 0.68, saturate: 0.88,
};
const MAX_DEFINITION: BackgroundFillDefinition = {
  blurRatio: 0.065, minBlurPx: 44, maxBlurPx: 108, brightness: 0.64, saturate: 0.84,
};
const STRENGTH_STOPS = [
  { strength: 0, definition: EMPTY_DEFINITION },
  { strength: 25, definition: SOFT_DEFINITION },
  { strength: 50, definition: DEFAULT_DEFINITION },
  { strength: 75, definition: STRONG_DEFINITION },
  { strength: 100, definition: MAX_DEFINITION },
] as const;

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

export function isBackgroundFillStrength(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_STRENGTH
    && value <= MAX_STRENGTH;
}

export function backgroundFillStrengthOf(
  item: Pick<TimelineItem, 'backgroundFillStrength'>,
): number {
  return isBackgroundFillStrength(item.backgroundFillStrength)
    ? item.backgroundFillStrength
    : DEFAULT_BACKGROUND_FILL_STRENGTH;
}

export function setBackgroundFillState(
  state: TimelineState,
  itemId: string,
  enabled: boolean,
  strength?: number,
): TimelineState {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || (enabled && !isBackgroundFillEligible(state, item))) return state;
  if (strength !== undefined && !isBackgroundFillStrength(strength)) return state;
  const storedStrength = strength !== DEFAULT_BACKGROUND_FILL_STRENGTH ? strength : undefined;
  if ((item.backgroundFill === true) === enabled
    && (!enabled || strength === undefined || item.backgroundFillStrength === storedStrength)) return state;
  return {
    ...state,
    items: state.items.map((candidate) => {
      if (candidate.id !== itemId) return candidate;
      const { backgroundFill: _backgroundFill, backgroundFillStrength: _strength, ...rest } = candidate;
      if (!enabled) return rest;
      return storedStrength === undefined
        ? { ...rest, backgroundFill: true }
        : { ...rest, backgroundFill: true, backgroundFillStrength: storedStrength };
    }),
  };
}

const interpolate = (from: number, to: number, progress: number): number => (
  from + (to - from) * progress
);

function definitionForStrength(strength: number): BackgroundFillDefinition {
  const foundIndex = STRENGTH_STOPS.findIndex((stop) => strength <= stop.strength);
  const upperIndex = foundIndex < 0 ? STRENGTH_STOPS.length - 1 : foundIndex;
  const upper = STRENGTH_STOPS[upperIndex];
  if (upperIndex === 0) return upper.definition;
  const lower = STRENGTH_STOPS[upperIndex - 1];
  const progress = (strength - lower.strength) / (upper.strength - lower.strength);
  return {
    blurRatio: interpolate(lower.definition.blurRatio, upper.definition.blurRatio, progress),
    minBlurPx: interpolate(lower.definition.minBlurPx, upper.definition.minBlurPx, progress),
    maxBlurPx: interpolate(lower.definition.maxBlurPx, upper.definition.maxBlurPx, progress),
    brightness: interpolate(lower.definition.brightness, upper.definition.brightness, progress),
    saturate: interpolate(lower.definition.saturate, upper.definition.saturate, progress),
  };
}

export function backgroundFillAppearance(
  width: number,
  height: number,
  strength = DEFAULT_BACKGROUND_FILL_STRENGTH,
): BackgroundFillAppearance {
  const shortSide = Math.max(1, Math.min(width, height));
  const definition = definitionForStrength(strength);
  const blurPx = Math.max(
    definition.minBlurPx,
    Math.min(definition.maxBlurPx, Math.round(shortSide * definition.blurRatio)),
  );
  return {
    blurPx,
    brightness: definition.brightness,
    saturate: definition.saturate,
    overscanScale: 1 + (blurPx * BLUR_EDGE_SPAN) / shortSide,
  };
}

export function backgroundFillAppearanceFor(
  item: Pick<TimelineItem, 'backgroundFillStrength'>,
  width: number,
  height: number,
): BackgroundFillAppearance {
  return backgroundFillAppearance(width, height, backgroundFillStrengthOf(item));
}

export function backgroundFillFilter(
  appearance: BackgroundFillAppearance,
  filters?: ClipFilters,
): string {
  return `brightness(${(filters?.brightness ?? 1) * appearance.brightness}) contrast(${filters?.contrast ?? 1}) saturate(${(filters?.saturate ?? 1) * appearance.saturate}) blur(${appearance.blurPx + (filters?.blur ?? 0)}px)`;
}
