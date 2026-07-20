import type { TimelineItem } from '../editor/types';
import { ALL_FX } from './fx/effects';

export function glEffects(item: TimelineItem) {
  return (item.effects ?? [])
    .filter((effect) => effect.assetId in ALL_FX)
    .map((effect) => ({ fx: effect, def: ALL_FX[effect.assetId] }));
}

/** The first stack entry whose assetId is a registered GL effect. */
export function firstGlEffect(item: TimelineItem) {
  return glEffects(item)[0] ?? null;
}
