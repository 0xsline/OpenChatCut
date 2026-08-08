import { isBackgroundFillEligible } from '../../editor/backgroundFill';
import type { TimelineItem, TimelineState } from '../../editor/types';

type BackgroundFillUpdate = { value: boolean } | { error: string } | null;

export function validateBackgroundFillUpdate(
  state: TimelineState,
  item: TimelineItem,
  value: unknown,
  targetTrack?: string,
): BackgroundFillUpdate {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') return { error: 'backgroundFill must be a boolean' };
  if (item.kind !== 'video' && item.kind !== 'image') {
    return { error: `backgroundFill only supports video/image clips (got ${item.kind})` };
  }
  const targetItem = targetTrack === undefined ? item : { ...item, track: targetTrack };
  if (value && !isBackgroundFillEligible(state, targetItem)) {
    return { error: 'backgroundFill only supports video/image clips on the bottom video track (V1)' };
  }
  return { value };
}
