import { isBackgroundFillEligible, isBackgroundFillPreset } from '../../editor/backgroundFill';
import type { BackgroundFillPreset, TimelineItem, TimelineState } from '../../editor/types';

type BackgroundFillUpdate = {
  enabled: boolean;
  preset?: BackgroundFillPreset;
} | { error: string } | null;

export function validateBackgroundFillUpdate(
  state: TimelineState,
  item: TimelineItem,
  enabledValue: unknown,
  presetValue: unknown,
  targetTrack?: string,
): BackgroundFillUpdate {
  if (enabledValue === undefined && presetValue === undefined) return null;
  if (enabledValue !== undefined && typeof enabledValue !== 'boolean') {
    return { error: 'backgroundFill must be a boolean' };
  }
  if (presetValue !== undefined && !isBackgroundFillPreset(presetValue)) {
    return { error: 'backgroundFillPreset must be one of: soft, medium, strong, maximum' };
  }
  if (item.kind !== 'video' && item.kind !== 'image') {
    return { error: `backgroundFill only supports video/image clips (got ${item.kind})` };
  }
  const enabled = typeof enabledValue === 'boolean' ? enabledValue : true;
  const targetItem = targetTrack === undefined ? item : { ...item, track: targetTrack };
  if (enabled && !isBackgroundFillEligible(state, targetItem)) {
    return { error: 'backgroundFill only supports video/image clips on the bottom video track (V1)' };
  }
  return {
    enabled,
    ...(presetValue === undefined ? {} : { preset: presetValue as BackgroundFillPreset }),
  };
}
