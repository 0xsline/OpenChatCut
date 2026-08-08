import { isBackgroundFillEligible, isBackgroundFillStrength } from '../../editor/backgroundFill';
import type { TimelineItem, TimelineState } from '../../editor/types';

type BackgroundFillUpdate = {
  enabled: boolean;
  strength?: number;
} | { error: string } | null;

export function validateBackgroundFillUpdate(
  state: TimelineState,
  item: TimelineItem,
  enabledValue: unknown,
  strengthValue: unknown,
  targetTrack?: string,
): BackgroundFillUpdate {
  if (enabledValue === undefined && strengthValue === undefined) return null;
  if (enabledValue !== undefined && typeof enabledValue !== 'boolean') {
    return { error: 'backgroundFill must be a boolean' };
  }
  if (strengthValue !== undefined && !isBackgroundFillStrength(strengthValue)) {
    return { error: 'backgroundFillStrength must be an integer from 0 to 100' };
  }
  if (item.kind !== 'video' && item.kind !== 'image') {
    return { error: `backgroundFill only supports video/image clips (got ${item.kind})` };
  }
  const enabled = typeof enabledValue === 'boolean' ? enabledValue : true;
  const targetItem = targetTrack === undefined ? item : { ...item, track: targetTrack };
  if (enabled && !isBackgroundFillEligible(state, targetItem)) {
    return { error: 'backgroundFill only supports video/image clips on the bottom video track (V1)' };
  }
  if (strengthValue === undefined) return { enabled };
  return { enabled, strength: strengthValue };
}
