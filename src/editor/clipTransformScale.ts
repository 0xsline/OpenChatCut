import type { ClipTransform, KeyframeProp, TimelineItem } from './types';

/** Resolved non-uniform axes (1 = 100%). Legacy `scale` is the uniform fallback. */
export function resolveClipScaleAxes(
  transform: Pick<ClipTransform, 'scale' | 'scaleX' | 'scaleY'> | undefined,
  keyframed?: Partial<Record<'scale' | 'scaleX' | 'scaleY', number | undefined>>,
): { scaleX: number; scaleY: number } {
  // Axis-specific static/keyframe wins over uniform, so edge drags survive a uniform scale curve.
  const scaleX = keyframed?.scaleX
    ?? transform?.scaleX
    ?? keyframed?.scale
    ?? transform?.scale
    ?? 1;
  const scaleY = keyframed?.scaleY
    ?? transform?.scaleY
    ?? keyframed?.scale
    ?? transform?.scale
    ?? 1;
  return { scaleX, scaleY };
}

/** Sample keyframed scale axes for an item at a local frame (caller supplies samples). */
export function resolveItemScaleAxes(
  item: Pick<TimelineItem, 'transform'>,
  keyframed: Partial<Record<'scale' | 'scaleX' | 'scaleY', number | undefined>> = {},
): { scaleX: number; scaleY: number } {
  return resolveClipScaleAxes(item.transform, keyframed);
}

/** Uniform inspector/write: both axes + legacy scale stay in sync. */
export function uniformScalePatch(scale: number): ClipTransform {
  return { scale, scaleX: scale, scaleY: scale };
}

/** Layout / full reset clears non-uniform residue via explicit undefined. */
export function clearAxisScalePatch(): Pick<ClipTransform, 'scaleX' | 'scaleY'> {
  return { scaleX: undefined, scaleY: undefined };
}

export const SCALE_AXIS_PROPS = ['scaleX', 'scaleY'] as const satisfies readonly KeyframeProp[];
