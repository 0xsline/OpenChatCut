import {
  defaultTrackId,
  type BackgroundFillPreset,
  type ClipFilters,
  type TimelineItem,
  type TimelineState,
} from './types';

const BLUR_EDGE_SPAN = 4;

interface BackgroundFillPresetDefinition {
  blurRatio: number;
  minBlurPx: number;
  maxBlurPx: number;
  brightness: number;
  saturate: number;
}

export const BACKGROUND_FILL_PRESETS = ['soft', 'medium', 'strong', 'maximum'] as const;
export const DEFAULT_BACKGROUND_FILL_PRESET: BackgroundFillPreset = 'medium';

const PRESET_DEFINITIONS: Record<BackgroundFillPreset, BackgroundFillPresetDefinition> = {
  soft: { blurRatio: 0.02, minBlurPx: 14, maxBlurPx: 40, brightness: 0.82, saturate: 0.96 },
  medium: { blurRatio: 0.035, minBlurPx: 24, maxBlurPx: 64, brightness: 0.72, saturate: 0.9 },
  strong: { blurRatio: 0.05, minBlurPx: 34, maxBlurPx: 84, brightness: 0.68, saturate: 0.88 },
  maximum: { blurRatio: 0.065, minBlurPx: 44, maxBlurPx: 108, brightness: 0.64, saturate: 0.84 },
};

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

export function isBackgroundFillPreset(value: unknown): value is BackgroundFillPreset {
  return typeof value === 'string'
    && BACKGROUND_FILL_PRESETS.includes(value as BackgroundFillPreset);
}

export function backgroundFillPresetOf(item: Pick<TimelineItem, 'backgroundFillPreset'>): BackgroundFillPreset {
  return item.backgroundFillPreset ?? DEFAULT_BACKGROUND_FILL_PRESET;
}

export function setBackgroundFillState(
  state: TimelineState,
  itemId: string,
  enabled: boolean,
  preset?: BackgroundFillPreset,
): TimelineState {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || (enabled && !isBackgroundFillEligible(state, item))) return state;
  const storedPreset = preset && preset !== DEFAULT_BACKGROUND_FILL_PRESET ? preset : undefined;
  if ((item.backgroundFill === true) === enabled
    && (!enabled || preset === undefined || item.backgroundFillPreset === storedPreset)) return state;
  return {
    ...state,
    items: state.items.map((candidate) => {
      if (candidate.id !== itemId) return candidate;
      const { backgroundFill: _backgroundFill, backgroundFillPreset: _preset, ...rest } = candidate;
      if (!enabled) return rest;
      return storedPreset
        ? { ...rest, backgroundFill: true, backgroundFillPreset: storedPreset }
        : { ...rest, backgroundFill: true };
    }),
  };
}

export function backgroundFillAppearance(
  width: number,
  height: number,
  preset: BackgroundFillPreset = DEFAULT_BACKGROUND_FILL_PRESET,
): BackgroundFillAppearance {
  const shortSide = Math.max(1, Math.min(width, height));
  const definition = PRESET_DEFINITIONS[preset];
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
  item: Pick<TimelineItem, 'backgroundFillPreset'>,
  width: number,
  height: number,
): BackgroundFillAppearance {
  return backgroundFillAppearance(width, height, backgroundFillPresetOf(item));
}

export function backgroundFillFilter(
  appearance: BackgroundFillAppearance,
  filters?: ClipFilters,
): string {
  return `brightness(${(filters?.brightness ?? 1) * appearance.brightness}) contrast(${filters?.contrast ?? 1}) saturate(${(filters?.saturate ?? 1) * appearance.saturate}) blur(${appearance.blurPx + (filters?.blur ?? 0)}px)`;
}
